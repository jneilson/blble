export async function extractPageSignals(page, httpStatus = null) {
  const finalUrl = page.url();

  const metaTitles = await page.evaluate(() => {
    const pick = (sel, attr = "content") => {
      const el = document.querySelector(sel);
      return el ? (attr === "text" ? el.textContent : el.getAttribute(attr)) : null;
    };
    return {
      documentTitle: document.title || null,
      ogTitle: pick('meta[property="og:title"]'),
      twitterTitle: pick('meta[name="twitter:title"]'),
      citationTitle: pick('meta[name="citation_title"]'),
      dcTitle: pick('meta[name="DC.Title"]')
    };
  });

  const observedTitle =
    metaTitles.citationTitle ||
    metaTitles.ogTitle ||
    metaTitles.twitterTitle ||
    metaTitles.documentTitle ||
    "";

  const visibleText = await page.evaluate(() => {
    const text = document.body?.innerText || "";
    return text.replace(/\s+/g, " ").trim();
  });

  const textExcerpt = visibleText.length > 9000 ? visibleText.slice(0, 9000) : visibleText;

  const contentTypeGuess = await page.evaluate(() => {
    const url = location.href.toLowerCase();
    if (url.includes(".pdf")) return "pdf";
    const hasPdfEmbed = !!document.querySelector("embed[type='application/pdf'], object[type='application/pdf'], iframe[src*='.pdf']");
    if (hasPdfEmbed) return "pdf";
    const hasVideo = !!document.querySelector("video, iframe[src*='youtube'], iframe[src*='vimeo']");
    if (hasVideo) return "video";
    return "html";
  });

  const paywallSignals = await detectPaywallSignals(page, visibleText);
  const foundIdentifiers = findIdentifiers(visibleText);

  const openAthensHint = await page.evaluate(() => {
    const title = (document.title || "").toLowerCase();
    const txt = (document.body?.innerText || "").toLowerCase();
    return title.includes("openathens") || txt.includes("openathens");
  });

  return {
    httpStatus,
    finalUrl,
    observedTitle,
    metaTitles,
    contentTypeGuess,
    textExcerpt,
    paywallSignals,
    foundIdentifiers,
    openAthensHint
  };
}

async function detectPaywallSignals(page, visibleText) {
  const signals = [];
  const hay = (visibleText || "").toLowerCase();

  const keywordHits = [
    "subscribe to continue",
    "subscribe to read",
    "sign in to continue",
    "log in to continue",
    "purchase this article",
    "already a subscriber",
    "you have reached your limit",
    "to continue reading",
    "subscription required",
    "access through your institution",
    "get access"
  ].filter((k) => hay.includes(k));

  if (keywordHits.length) signals.push(`keyword:${keywordHits.slice(0, 4).join("|")}`);

  const overlay = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll("body *"));
    const top = els
      .map((el) => {
        const style = window.getComputedStyle(el);
        const z = parseInt(style.zIndex || "0", 10);
        const pos = style.position;
        const rect = el.getBoundingClientRect();
        const area = rect.width * rect.height;
        const fixedish = pos === "fixed" || pos === "sticky";
        return { z, fixedish, area, tag: el.tagName };
      })
      .filter((x) => x.fixedish && x.area > 200_000 && x.z >= 10)
      .sort((a, b) => b.z - a.z)[0];

    const bodyStyle = window.getComputedStyle(document.body);
    const locked = bodyStyle.overflow === "hidden" || bodyStyle.position === "fixed";

    return { top, locked };
  });

  if (overlay?.locked) signals.push("overlay:scroll_locked");
  if (overlay?.top) signals.push(`overlay:fixed_high_z(tag=${overlay.top.tag},z=${overlay.top.z})`);

  const len = (visibleText || "").length;
  if (len > 0 && len < 1200) signals.push("content:very_short");

  return signals;
}

function findIdentifiers(text) {
  const t = (text || "").slice(0, 200000);
  const out = { dois: [], issns: [], isbns: [] };

  const doiRegex = /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/gi;
  out.dois = unique((t.match(doiRegex) || []).slice(0, 10));

  const issnRegex = /\b\d{4}-\d{3}[\dX]\b/gi;
  out.issns = unique((t.match(issnRegex) || []).slice(0, 10));

  const isbnRegex = /\b(?:97[89][-\s]?)?\d{1,5}[-\s]?\d{1,7}[-\s]?\d{1,7}[-\s]?[\dX]\b/gi;
  out.isbns = unique((t.match(isbnRegex) || []).slice(0, 10));

  return out;
}

function unique(arr) {
  return Array.from(new Set(arr.map((x) => String(x).trim()))).filter(Boolean);
}
