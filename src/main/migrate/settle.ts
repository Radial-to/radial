// How a page settles before a full-page screenshot (plans/site-migration.md):
// the Mac app's hidden shooter window (shots.ts) and radial serve's browser
// (src/headless/page.ts) run the same script, so their screenshots compare
// like for like. No Electron here: the headless core loads it too.

// Scroll through once so lazy images and scroll-triggered reveals settle, then
// wait for fonts and images before capturing from the top.
export const SETTLE = (ms: number): string => `(async () => {
  const sleep = t => new Promise(r => setTimeout(r, t));
  const step = Math.max(300, Math.floor(innerHeight * 0.8));
  for (let y = 0, i = 0; y < document.documentElement.scrollHeight && i < 60; y += step, i++) { scrollTo(0, y); await sleep(70); }
  scrollTo(0, document.documentElement.scrollHeight); await sleep(120); scrollTo(0, 0);
  try { await document.fonts.ready; } catch {}
  await Promise.all([...document.images].filter(img => !img.complete).map(img => new Promise(r => { img.addEventListener('load', r, { once: true }); img.addEventListener('error', r, { once: true }); setTimeout(r, 5000); })));
  await sleep(${ms});
  return document.documentElement.scrollHeight;
})()`;

/** The viewport height both shooters lay a page out against: 100vh sections keep their real height, and the capture renders beyond it. */
export const VIEWPORT_HEIGHT = 900;
