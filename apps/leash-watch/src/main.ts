/**
 * The Leash screen watcher daemon — on-device activity sensing.
 *
 *   npm run watch                 # interactive (p pause · f/F forget 5/60m · q quit)
 *   npm run watch -- --forget 30  # non-interactive: forget the last 30 min and exit
 *
 * Per tick (default every 60s): skip if idle/locked → read the frontmost app + window
 * (Accessibility) → apply the allow/block privacy gate → debounce when nothing changed →
 * capture the screen → summarize with the on-device VLM (qwen3vl) → append {ts,app,window,
 * summary,tags} to the activity trail. Frames are deleted immediately; nothing leaves the
 * device. Ctrl-C / `q` drains cleanly.
 */
import { INTERVAL_SEC, IDLE_SKIP_SEC, ACTIVITY_LOG, appAllowed } from "./config.ts";
import { frontmost, idleSeconds } from "./ax.ts";
import { captureScreen, CaptureError } from "./capture.ts";
import { summarizeFrame, visionInFlight } from "./vision.ts";
import { appendRecord, forgetLastMinutes, type ActivityRecord } from "./store.ts";
import { setupControls, type Controls } from "./controls.ts";

let stopping = false;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Last observed app::window — debounces repeat captures of an unchanged screen. */
let lastKey = "";

async function tick(controls: Controls): Promise<void> {
  if (controls.paused()) return;

  const idle = await idleSeconds();
  if (idle >= IDLE_SKIP_SEC) return; // away / screen locked

  const { app, window } = await frontmost();
  if (!app) return;
  if (!appAllowed(app)) {
    console.log(`\n   ⏭  skipping ${app} (privacy gate)`);
    controls.render();
    return;
  }

  const key = `${app}::${window}`;
  if (key === lastKey) return; // unchanged since last observation — debounce

  let frame: string;
  try {
    frame = await captureScreen();
  } catch (err) {
    if (err instanceof CaptureError) {
      console.error(`\n   ⚠ ${err.message}`);
      controls.render();
      return;
    }
    throw err;
  }

  const { summary, tags } = await summarizeFrame(frame, app);
  const rec: ActivityRecord = { ts: new Date().toISOString(), app, window, summary, tags };
  appendRecord(rec);
  lastKey = key;
  console.log(`\n📸 ${app}${window ? ` — ${window}` : ""}: ${summary}`);
  controls.render();
}

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) {
    // Second quit = force. Warn honestly: dying mid-decode disconnects the serve and wedges it.
    console.log("\n   ⚠ force quit — if a vision request was mid-generation this can wedge the qvac serve");
    process.exit(1);
  }
  shuttingDown = true;
  stopping = true;
  console.log("\n⏹  stopping screen watcher…");
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  } catch {
    /* ignore */
  }
  // Never exit while a vision request is mid-decode — the disconnect wedges the qvac serve
  // (machine-wide, reboot-only recovery). Drain it first; quit again to force.
  const pending = visionInFlight();
  if (pending) {
    console.log("   ⏳ draining the in-flight vision request (exiting mid-decode wedges the serve; quit again to force)…");
    void Promise.resolve(pending)
      .catch(() => {})
      .then(() => {
        console.log("✅ leash-watch stopped.");
        process.exit(0);
      });
    return;
  }
  console.log("✅ leash-watch stopped.");
  process.exit(0);
}

async function main(): Promise<void> {
  // Non-interactive forget: `npm run watch -- --forget <min>`.
  const argv = process.argv.slice(2);
  const fi = argv.indexOf("--forget");
  if (fi !== -1) {
    const min = Number(argv[fi + 1] ?? "5");
    const dropped = forgetLastMinutes(min);
    console.log(`🧽 forgot ${dropped} record(s) from the last ${min} min.`);
    return;
  }

  console.log("🍄 Leash — screen watcher\n");
  console.log("👁  Privacy: captures are summarized on-device and the frame PNG is deleted immediately.");
  console.log(`    Cadence ${INTERVAL_SEC}s · idle-skip ${IDLE_SKIP_SEC}s · trail → ${ACTIVITY_LOG}`);
  console.log("    Controls: p/space pause · f/F forget 5/60m · q/Ctrl-C quit\n");

  const controls = setupControls({
    onForget: (min) => {
      const dropped = forgetLastMinutes(min);
      console.log(`\n🧽 forgot ${dropped} record(s) from the last ${min} min.`);
    },
    onQuit: () => shutdown(),
  });

  process.on("SIGINT", () => shutdown());
  process.on("SIGTERM", () => shutdown());

  while (!stopping) {
    try {
      await tick(controls);
    } catch (err) {
      console.error("\n⚠ tick error:", String(err).slice(0, 200));
      controls.render();
    }
    if (stopping) break;
    const next = Date.now() + INTERVAL_SEC * 1000;
    while (!stopping && Date.now() < next) await sleep(Math.min(1000, next - Date.now()));
  }
}

main().catch((err) => {
  console.error("❌ watcher crashed:", err);
  process.exit(1);
});
