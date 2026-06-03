/**
 * The newsroom daemon — the autonomous editor.
 *
 *   npm run newsroom
 *
 * On a cadence (default 60 min, from DaemonState.cadenceMin) it:
 *   1. discovers fresh external stories from the feeds (online),
 *   2. stages today's personal brief from the private graph (offline),
 *   3. drains the QUEUED backlog ONE article at a time through the full pipeline
 *      (research → draft → review → on-device hero → publish),
 * updating DaemonState (status / lastDiscoveryAt / nextCheckAt / cadence) and emitting
 * a DaemonRun row + audit record per step — the live feed Mission Control reads.
 *
 * Models are loaded once and reused across every tick. Ctrl-C drains cleanly.
 */
import { initDb, prisma, DaemonStatus, Stage } from "@mycelium/db";
import { recordRun, openNewsroom, closeNewsroom, type Newsroom } from "./context.ts";
import { ensureState, patchState } from "./state.ts";
import { discover } from "./discover.ts";
import { proposePersonalBrief } from "./personal.ts";
import { runPipeline } from "./pipeline.ts";
import { DEFAULT_CADENCE_MIN } from "./config.ts";

const DISCOVER_PER_TICK = Number(process.env["UNDERSTORY_DISCOVER_PER_TICK"] ?? "2");

let stopping = false;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Process every QUEUED article, oldest first, one at a time. */
async function drainQueue(nr: Newsroom): Promise<void> {
  // Loop until no QUEUED remain (a failed article leaves QUEUED, so it won't re-loop).
  for (;;) {
    if (stopping) return;
    const next = await prisma.article.findFirst({ where: { stage: Stage.QUEUED }, orderBy: { createdAt: "asc" } });
    if (!next) return;
    console.log(`\n📰 [${next.section}] ${next.headline.slice(0, 70)}`);
    try {
      await runPipeline(nr, next.id);
      const done = await prisma.article.findUniqueOrThrow({ where: { id: next.id }, include: { sources: true, claims: true } });
      console.log(`   → ${done.stage}  /${done.date}/${done.slug}  (${done.sources.length} sources, ${done.claims.length} claims, hero: ${done.heroImagePath ? "yes" : "no"})`);
    } catch (err) {
      console.error(`   ✗ pipeline failed for ${next.id}:`, String(err).slice(0, 200));
      nr.audit.record({ event: "note", extra: { role: "pipeline-failed", articleId: next.id, error: String(err).slice(0, 200) } });
    }
  }
}

async function tick(nr: Newsroom): Promise<void> {
  // 1. Discover (network, resilient to offline).
  const disc = await recordRun("discovery", undefined, () => discover(DISCOVER_PER_TICK));
  await patchState({ lastDiscoveryAt: new Date() });
  console.log(`📡 discovery: ${disc.createdIds.length} new (scanned ${disc.scanned}, ${disc.feedsOk} feeds ok)`);

  // 2. Today's personal brief (self-guards to one per day).
  const briefId = await proposePersonalBrief(nr);
  if (briefId) console.log("📓 personal brief queued");

  // 3. Drain the queue, one article in-progress at a time.
  await drainQueue(nr);
}

let shuttingDown = false;
/**
 * Idempotent shutdown. Writes STOPPED FIRST (a sub-ms SQLite write, so Mission
 * Control reflects it even if the runner kills us right after), then best-effort
 * unloads models with a timeout (the SDK's Bare worker may already be dying), then
 * exits. Wired to both SIGINT and SIGTERM.
 */
async function shutdown(nr: Newsroom): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  stopping = true;
  console.log("\n⏹  shutting down…");
  try {
    await patchState({ status: DaemonStatus.STOPPED, nextCheckAt: null });
  } catch {
    /* db may be gone */
  }
  try {
    await Promise.race([closeNewsroom(nr), sleep(8000)]);
  } catch {
    /* worker may already be dead */
  }
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  console.log("✅ newsroom stopped.");
  process.exit(0);
}

async function main(): Promise<void> {
  await initDb();
  await ensureState();
  console.log("🍄 The Understory — newsroom daemon\n");
  const nr = await openNewsroom();
  await patchState({ status: DaemonStatus.RUNNING, startedAt: new Date() });

  process.on("SIGINT", () => void shutdown(nr));
  process.on("SIGTERM", () => void shutdown(nr));

  while (!stopping) {
    await tick(nr);
    if (stopping) break;

    const state = await ensureState();
    const cadenceMin = state.cadenceMin || DEFAULT_CADENCE_MIN;
    const next = new Date(Date.now() + cadenceMin * 60_000);
    await patchState({ status: DaemonStatus.IDLE, nextCheckAt: next });
    console.log(`\n💤 next discovery at ${next.toLocaleTimeString("en-US", { hour12: false })} (cadence ${cadenceMin}m). Ctrl-C to stop.`);

    // Sleep in short slices so Ctrl-C stays responsive.
    while (!stopping && Date.now() < next.getTime()) {
      await sleep(Math.min(1000, next.getTime() - Date.now()));
    }
    if (!stopping) await patchState({ status: DaemonStatus.RUNNING });
  }
}

main().catch((err) => {
  console.error("❌ daemon crashed:", err);
  process.exit(1);
});
