// Capture static component screenshots for the landing page (public/landing/<slug>.png).
// Uses Electron's webContents.capturePage() — no new deps, no headless-chrome download.
// Run the Leash dev server with LEASH_AUTH=0 first, then point this at it.
//
//   node_modules/.bin/electron apps/web/scripts/capture-landing.cjs
//
const { app, BrowserWindow } = require("electron");
const { writeFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");

const BASE = process.env.CAP_URL || "http://localhost:6801";
const OUT = join(__dirname, "..", "public", "landing");
// [captureURL, slug] — slug matches the landing figure's route prop; captureURL is
// the page that best shows that component (e.g. the Models TAB of /brain).
const SHOTS = [
  ["/chat", "chat"],
  ["/mesh", "mesh"],
  ["/brain?tab=models", "brain"],
  ["/economy", "economy"],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.commandLine.appendSwitch("disable-gpu");

app.whenReady().then(async () => {
  mkdirSync(OUT, { recursive: true });
  // 4:3 desktop viewport — matches the landing frame's aspect-ratio, top-anchored crop.
  const win = new BrowserWindow({
    width: 1440,
    height: 1080,
    show: true,
    webPreferences: { offscreen: false, backgroundThrottling: false, sandbox: false },
  });

  for (const [route, slug] of SHOTS) {
    try {
      await win.loadURL(BASE + route);
    } catch (e) {
      console.log(`load failed ${route}: ${e.message}`);
    }
    // Let the route compile (dev), hydrate, and settle.
    await sleep(7000);
    const img = await win.webContents.capturePage();
    const png = img.toPNG();
    writeFileSync(join(OUT, `${slug}.png`), png);
    console.log(`captured ${slug}.png (${Math.round(png.length / 1024)} KB)`);
  }

  app.quit();
});

app.on("window-all-closed", () => app.quit());
