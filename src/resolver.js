export async function tryResolveToFullText({ page, context, maxClicks = 3 }) {
  const chain = [];
  let clicks = 0;
  let lastHttpStatus = null;

  while (clicks < maxClicks) {
    const urlBefore = page.url();
    const decision = await pickBestFullTextLink(page);
    if (!decision) break;

    chain.push({ from: urlBefore, action: "click", text: decision.text, href: decision.href, score: decision.score });

    const nav = waitForNavigationOrPopup({ page, context });

    await page.evaluate((href) => {
      const a = Array.from(document.querySelectorAll("a[href]")).find(x => x.href === href);
      if (a) a.click();
      else window.location.href = href;
    }, decision.href);

    const outcome = await nav;

    if (outcome?.type === "nav" && outcome.response) {
      try { lastHttpStatus = outcome.response.status(); } catch {}
    }

    if (outcome?.type === "popup" && outcome.page) {
      await page.close().catch(() => {});
      page = outcome.page;
      try {
        const resp = await page.waitForResponse(() => true, { timeout: 5000 }).catch(() => null);
        if (resp) lastHttpStatus = resp.status();
      } catch {}
    }

    await page.waitForTimeout(1200);

    const urlAfter = page.url();
    if (urlAfter !== urlBefore) chain[chain.length - 1].to = urlAfter;

    clicks++;

    const stop = await looksLikeContentPage(page);
    if (stop) break;
  }

  return { page, resolverChain: chain, resolverHttpStatus: lastHttpStatus };
}

async function pickBestFullTextLink(page) {
  const candidates = await page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const links = Array.from(document.querySelectorAll("a[href]"))
      .map((a) => ({ text: norm(a.textContent), href: a.href }))
      .filter((x) => /^https?:\/\//i.test(x.href));
    return { links };
  });

  const best = scoreLinks(candidates.links);
  if (!best || best.score < 8) return null;
  return best;
}

function scoreLinks(links) {
  const scored = [];
  for (const l of links) {
    const text = (l.text || "").toLowerCase();
    const href = (l.href || "").toLowerCase();
    let score = 0;

    if (text.includes("full text")) score += 10;
    if (text.includes("pdf")) score += 9;
    if (text.includes("view pdf")) score += 9;
    if (text.includes("download pdf")) score += 9;
    if (text.includes("html full text")) score += 8;
    if (text.includes("article")) score += 4;
    if (text.includes("view online")) score += 4;

    if (text.includes("openurl")) score += 3;
    if (href.includes("openurl")) score += 3;
    if (href.includes("resolver")) score += 2;
    if (href.includes("sfx")) score += 2;
    if (href.includes("360link")) score += 2;
    if (href.includes("findit")) score += 2;

    if (href.endsWith(".pdf") || href.includes(".pdf?")) score += 6;

    if (text.includes("login")) score -= 2;
    if (text.includes("sign in")) score -= 2;
    if (text.includes("report a problem")) score -= 4;
    if (text.includes("help")) score -= 3;
    if (text.includes("privacy")) score -= 5;
    if (text.includes("terms")) score -= 5;

    if (!text || text.length < 3) score -= 4;

    scored.push({ ...l, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored[0] || null;
}

async function waitForNavigationOrPopup({ page, context }) {
  const navPromise = page
    .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15_000 })
    .then((response) => ({ type: "nav", response }))
    .catch(() => null);

  const popupPromise = context
    .waitForEvent("page", { timeout: 15_000 })
    .then((p) => ({ type: "popup", page: p }))
    .catch(() => null);

  return await Promise.race([navPromise, popupPromise]);
}

async function looksLikeContentPage(page) {
  const url = page.url().toLowerCase();
  if (url.includes(".pdf")) return true;

  const hint = await page.evaluate(() => {
    const title = (document.title || "").toLowerCase();
    const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
    const len = bodyText.length;

    const hasManyParagraphs = document.querySelectorAll("p").length >= 8;
    const hasPdfEmbed = !!document.querySelector("embed[type='application/pdf'], iframe[src*='.pdf'], object[type='application/pdf']");
    const hasOpenAthens = title.includes("openathens") || bodyText.toLowerCase().includes("openathens");

    return { len, hasManyParagraphs, hasPdfEmbed, hasOpenAthens };
  });

  if (hint.hasOpenAthens) return false;
  if (hint.hasPdfEmbed) return true;
  if (hint.hasManyParagraphs && hint.len > 2500) return true;

  return false;
}
