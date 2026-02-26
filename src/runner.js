import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { nanoid } from "nanoid";
import { extractPageSignals } from "./extract.js";
import { tryResolveToFullText } from "./resolver.js";
import { evaluateWithGemini } from "./gemini.js";
import { writeCsvResults } from "./report.js";
import { tryDismissCookieBanners } from "./cookies.js";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseGeminiRetrySeconds(msg) {
  if (!msg) return null;
  // Examples in error: "Please retry in 42.58s" or '"retryDelay":"42s"'
  const m1 = msg.match(/Please retry in\s+([0-9.]+)s/i);
  if (m1) return Math.ceil(Number(m1[1]));
  const m2 = msg.match(/"retryDelay"\s*:\s*"([0-9.]+)s"/i);
  if (m2) return Math.ceil(Number(m2[1]));
  return null;
}

/**
 * Persistent context profile locking:
 * - Login creates a persistent context for the profileDir.
 * - Audit MUST reuse that same context so we don't double-lock the user-data-dir
 *   AND so the authenticated OpenAthens session stays alive.
 */
let loginContext = null;
let loginProfileDir = null;
let loginContextClosed = false;

// Stop control
let stopRequested = false;
let activeContext = null;
let activePage = null;

/** Called by server /api/stop */
export function requestStop() {
  stopRequested = true;

  // Don't destroy the authenticated login context; just stop the active work.
  try {
    if (activePage) activePage.close().catch(() => {});
  } catch {}

  // If we created a separate context for the run (no login context), close it.
  if (activeContext && activeContext !== loginContext) {
    activeContext.close().catch(() => {});
  }
}

export async function startLoginSession({ profileDir }) {
  loginProfileDir = profileDir;

  if (loginContext && !loginContextClosed) return;

  loginContextClosed = false;
  loginContext = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1280, height: 800 }
  });

  // Track closure so we don't accidentally reuse a dead context.
  try {
    loginContext.on("close", () => {
      loginContextClosed = true;
    });
  } catch {}

  const page = await loginContext.newPage();
  await page.goto("https://www.google.com", { waitUntil: "domcontentloaded" });
}

export async function runAudit({ rows, profileDir, outDir, onProgress, onDone, onError }) {
  stopRequested = false;

  try {
    const throttle = Number(process.env.THROTTLE_MS ?? 750);
    const maxResolverClicks = Number(process.env.MAX_RESOLVER_CLICKS ?? 3);

    // Critical: if a login context exists for this profile, reuse it.
    const context = await getOrLaunchContext(profileDir);
    activeContext = context;

    // Open a NEW tab in the existing authenticated window; do not close existing pages.
    let page = await context.newPage();
    activePage = page;

    const results = [];
    const jsonlPath = path.join(outDir, "results.jsonl");
    fs.writeFileSync(jsonlPath, "", "utf-8");

    for (let i = 0; i < rows.length; i++) {
      if (stopRequested) {
        onProgress?.({
          progress: { done: i, total: rows.length },
          message: "Stopped by user."
        });
        break;
      }

      const row = rows[i];
      const id = row.meta?.citation_id || nanoid(10);

      onProgress?.({
        progress: { done: i, total: rows.length },
        message: `Row ${i + 1}/${rows.length}`
      });

      const screenshotPath = path.join(
        outDir,
        "screenshots",
        `${String(i + 1).padStart(4, "0")}_${id}.png`
      );

      const expected = row.expected || {};
      const meta = row.meta || {};

      const identityMode =
        (expected.journal_title && expected.journal_title.trim()) || (expected.issn && expected.issn.trim())
          ? "journal"
          : (expected.isbn && expected.isbn.trim())
            ? "book"
            : "journal";

      const baseResult = {
        id,
        row_number: meta.row_number ?? "",
        citation_id: meta.citation_id ?? "",
        reading_list_id: meta.reading_list_id ?? "",
        reading_list_name: meta.reading_list_name ?? "",
        course_code: meta.course_code ?? "",
        section: meta.section ?? "",
        citation_type: meta.citation_type ?? "",

        input_url: row.url || "",
        expected_title: expected.title || "",
        expected_author: expected.author || "",
        expected_journal_title: expected.journal_title || "",
        expected_publisher: expected.publisher || "",
        expected_issn: expected.issn || "",
        expected_isbn: expected.isbn || "",

        identity_mode: identityMode,

        http_status: null,
        final_url: null,
        observed_title: null,
        content_type: null,
        text_length: 0,
        paywall_signals: [],
        extraction_error: null,

        resolver_clicks: 0,
        resolver_chain: [],

        gemini_verdict: null,
        gemini_error: null,

        classification: null,
        match_confidence: null,
        title_match_score: null,
        paywall_detected: null,
        matched_fields: [],
        issue_summary: "",
        recommended_action: "",

        screenshot: `screenshots/${path.basename(screenshotPath)}`
      };

      if (!row.url) {
        const skipped = {
          ...baseResult,
          classification: "skipped_no_url",
          issue_summary: "No valid URL found in Citation Source/Citation Source 1."
        };
        results.push(skipped);
        fs.appendFileSync(jsonlPath, JSON.stringify(skipped) + "\n", "utf-8");
        onProgress?.({
          progress: { done: i + 1, total: rows.length },
          message: "Skipped (no URL)"
        });
        continue;
      }

      try {
        onProgress?.({
          progress: { done: i, total: rows.length },
          message: `Visiting: ${row.url}`
        });

        // Navigate
        const resp = await page.goto(row.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        const initialStatus = resp ? resp.status() : null;

        await page.waitForTimeout(900);
        await tryDismissCookieBanners(page);

        const resolved = await tryResolveToFullText({
          page,
          context,
          maxClicks: maxResolverClicks
        });
        page = resolved.page || page;
        activePage = page;

        await tryDismissCookieBanners(page);

        const finalStatus = resolved.resolverHttpStatus ?? initialStatus;

        const signals = await extractPageSignals(page, finalStatus);

        await page.screenshot({ path: screenshotPath, fullPage: true });

        let verdict;
        let geminiError = null;

        const maxGeminiRetries = Number(process.env.GEMINI_MAX_RETRIES ?? 3);
        const minGeminiDelayMs = Number(process.env.GEMINI_MIN_DELAY_MS ?? 1100);

        for (let attempt = 0; attempt <= maxGeminiRetries; attempt++) {
          try {
            // Simple client-side throttling to avoid hammering the API.
            if (attempt === 0 && minGeminiDelayMs > 0) await sleep(minGeminiDelayMs);

            verdict = await evaluateWithGemini({
              expected,
              signals,
              identityMode,
              resolverChain: resolved.resolverChain
            });

            geminiError = null;
            break;
          } catch (gemErr) {
            geminiError = gemErr?.message || String(gemErr);

            // If rate-limited, respect server's suggested retry if present.
            const retrySeconds = parseGeminiRetrySeconds(geminiError);
            const is429 = geminiError.includes("[429") || geminiError.includes("Too Many Requests") || geminiError.includes("RESOURCE_EXHAUSTED");

            if (attempt < maxGeminiRetries && (is429 || retrySeconds)) {
              const waitMs = (retrySeconds ? retrySeconds * 1000 : 5000) + attempt * 500;
              onProgress?.({
                progress: { done: i, total: rows.length },
                message: `Gemini rate-limited. Waiting ${Math.ceil(waitMs / 1000)}s then retrying (attempt ${attempt + 1}/${maxGeminiRetries})…`
              });
              await sleep(waitMs);
              continue;
            }

            // Give up
            verdict = {
              classification: "uncertain_needs_review",
              match_confidence: 0,
              title_match_score: 0,
              paywall_detected: false,
              matched_fields: [],
              issue_summary: "Gemini evaluation failed. See gemini_error.",
              recommended_action: "Manual review"
            };
            break;
          }
        }

        const itemResult = {
          ...baseResult,
          http_status: finalStatus,
          final_url: signals.finalUrl,
          observed_title: signals.observedTitle,
          content_type: signals.contentTypeGuess,
          text_length: signals.textExcerpt?.length || 0,
          paywall_signals: signals.paywallSignals,

          resolver_clicks: resolved.resolverChain?.length || 0,
          resolver_chain: resolved.resolverChain || [],

          gemini_verdict: verdict,
          gemini_error: geminiError,

          classification: verdict.classification,
          match_confidence: verdict.match_confidence,
          title_match_score: verdict.title_match_score,
          paywall_detected: verdict.paywall_detected,
          matched_fields: verdict.matched_fields || [],
          issue_summary: verdict.issue_summary || "",
          recommended_action: verdict.recommended_action || ""
        };

        results.push(itemResult);
        fs.appendFileSync(jsonlPath, JSON.stringify(itemResult) + "\n", "utf-8");
      } catch (err) {
        const msg = err?.message || String(err);

        // If the page got closed unexpectedly, try to open a new tab in the SAME context once.
        if (msg.includes("Target page") || msg.includes("has been closed")) {
          try {
            page = await context.newPage();
            activePage = page;
          } catch {}
        }

        const errored = {
          ...baseResult,
          extraction_error: msg,
          classification: "uncertain_needs_review",
          issue_summary: "Automation error while loading or extracting the page. See extraction_error."
        };

        try { await page.screenshot({ path: screenshotPath, fullPage: true }); } catch {}

        results.push(errored);
        fs.appendFileSync(jsonlPath, JSON.stringify(errored) + "\n", "utf-8");
      }

      onProgress?.({
        progress: { done: i + 1, total: rows.length },
        message: `Processed ${i + 1}/${rows.length}`
      });

      if (throttle > 0) await sleep(throttle);
    }

    fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2), "utf-8");
    await writeCsvResults(results, path.join(outDir, "results.csv"));
    await writeHtmlReport(results, path.join(outDir, "report.html"));

    // Never close the loginContext automatically (would log the user out mid-work).
    if (context !== loginContext) {
      await context.close().catch(() => {});
    }

    activeContext = null;
    activePage = null;
    onDone?.();
  } catch (e) {
    activeContext = null;
    activePage = null;
    onError?.(e);
  }
}

async function getOrLaunchContext(profileDir) {
  // Reuse the authenticated login context if present for this profile.
  if (loginContext && loginProfileDir === profileDir && !loginContextClosed) {
    return loginContext;
  }

  // If the login context was closed by the user, drop it and create a fresh one.
  if (loginContextClosed) {
    loginContext = null;
    loginContextClosed = false;
  }

  return await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1280, height: 800 }
  });
}

async function writeHtmlReport(results, outPath) {
  const escapeHtml = (str) =>
    String(str ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  const rowsHtml = results
    .map((r, idx) => {
      const status = r.extraction_error ? "ERROR" : (r.classification || "uncertain_needs_review");
      return `
        <tr class="${escapeHtml(status)}">
          <td>${idx + 1}</td>
          <td><b>${escapeHtml(status)}</b></td>
          <td>${escapeHtml(r.http_status ?? "")}</td>
          <td>${escapeHtml(r.expected_title)}</td>
          <td class="small">${escapeHtml(r.observed_title || "")}</td>
          <td><a href="${escapeHtml(r.final_url || r.input_url || "#")}" target="_blank">Open</a></td>
          <td><a href="${escapeHtml(r.screenshot)}" target="_blank">Screenshot</a></td>
          <td class="small">
            <div><b>Confidence:</b> ${r.match_confidence ?? ""}</div>
            <div><b>Title score:</b> ${r.title_match_score ?? ""}</div>
            <div><b>Paywall:</b> ${String(r.paywall_detected ?? "")}</div>
            <div><b>Resolver clicks:</b> ${r.resolver_clicks ?? 0}</div>
            <div><b>Issue:</b> ${escapeHtml(r.issue_summary || "")}</div>
            <div><b>Action:</b> ${escapeHtml(r.recommended_action || "")}</div>
            ${r.gemini_error ? `<div><b>Gemini error:</b> ${escapeHtml(r.gemini_error)}</div>` : ``}
            ${r.extraction_error ? `<div><b>Extraction error:</b> ${escapeHtml(r.extraction_error)}</div>` : ``}
          </td>
        </tr>
      `;
    })
    .join("\n");

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>blble report</title>
  <style>
    body { font-family: system-ui, Arial, sans-serif; margin: 16px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ddd; padding: 8px; vertical-align: top; }
    th { background: #f6f6f6; position: sticky; top: 0; }
    .small { font-size: 12px; line-height: 1.35; }
    tr.correct_and_accessible { background: #f3fff3; }
    tr.correct_but_paywalled_or_partial { background: #fffdf0; }
    tr.incorrect_article { background: #fff5f5; }
    tr.uncertain_needs_review { background: #f5f7ff; }
    tr.skipped_no_url { background: #f2f2f2; }
    tr.ERROR { background: #eee; }
  </style>
</head>
<body>
  <h1>blble report</h1>
  <p class="small">Generated: ${new Date().toISOString()}</p>
  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>Classification</th>
        <th>HTTP</th>
        <th>Expected title</th>
        <th>Observed title</th>
        <th>Link</th>
        <th>Screenshot</th>
        <th>Verdict</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
  </table>
</body>
</html>`;

  fs.writeFileSync(outPath, html, "utf-8");
}
