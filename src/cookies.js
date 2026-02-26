export async function tryDismissCookieBanners(page) {
  try {
    const clicked = await page.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
      const isVisible = (el) => {
        if (!el || !(el instanceof Element)) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        const style = window.getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return false;
        return true;
      };

      const acceptPhrases = [
        "accept all","accept","i accept","i agree","agree","allow all","allow","got it","ok","okay","continue"
      ];

      const buttons = Array.from(
        document.querySelectorAll("button, input[type='button'], input[type='submit'], a[role='button']")
      )
        .filter(isVisible)
        .map((el) => {
          const text = el.tagName === "INPUT" ? el.value : (el.textContent || "");
          return { el, text: norm(text) };
        });

      const overlayRoots = Array.from(document.querySelectorAll("div, section, aside"))
        .filter(isVisible)
        .map((el) => {
          const style = window.getComputedStyle(el);
          const pos = style.position;
          const z = parseInt(style.zIndex || "0", 10);
          const r = el.getBoundingClientRect();
          const area = r.width * r.height;
          const fixedish = pos === "fixed" || pos === "sticky";
          return { el, fixedish, z, area };
        })
        .filter((x) => x.fixedish && x.area > 120_000 && x.z >= 10)
        .sort((a, b) => (b.z - a.z) || (b.area - a.area))
        .slice(0, 3)
        .map((x) => x.el);

      const inOverlay = (btnEl) => overlayRoots.some((root) => root.contains(btnEl));

      const scored = buttons
        .map((b) => {
          let score = 0;
          if (inOverlay(b.el)) score += 6;
          for (const p of acceptPhrases) {
            if (b.text === p) score += 10;
            else if (b.text.includes(p)) score += 6;
          }
          if (b.text.includes("reject")) score -= 6;
          if (b.text.includes("manage")) score -= 4;
          if (b.text.includes("preferences")) score -= 4;
          if (b.text.includes("settings")) score -= 4;
          return { ...b, score };
        })
        .sort((a, b) => b.score - a.score);

      const best = scored[0];
      if (!best || best.score < 8) return false;

      best.el.click();
      return true;
    });

    if (clicked) await page.waitForTimeout(900);
  } catch {}
}
