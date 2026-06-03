/**
 * Seed = ONE real pipeline pass (no hand-written rows).
 *
 *   npm run newsroom:seed
 *
 * Discovers 1–2 external stories (online), stages today's personal brief from the
 * private graph (offline), then runs each through the full council-backed pipeline —
 * research → draft → review → on-device hero image → publish. The result is a real
 * edition in SQLite that the web app reads. If discovery is offline, the personal
 * brief alone still produces a genuine, fully on-device article.
 */
import { initDb, prisma, DaemonStatus } from "@mycelium/db";
import { recordRun, openNewsroom, closeNewsroom } from "./context.ts";
import { ensureState, patchState } from "./state.ts";
import { discover } from "./discover.ts";
import { proposePersonalBrief } from "./personal.ts";
import { runPipeline } from "./pipeline.ts";
import { today } from "./config.ts";

const EXTERNAL_LIMIT = Number(process.argv[2] ?? "2");

async function main(): Promise<void> {
  await initDb();
  await ensureState();
  await patchState({ status: DaemonStatus.RUNNING, startedAt: new Date() });
  console.log("🍄 The Understory — seeding one real edition\n");

  const nr = await openNewsroom();
  try {
    // 1. Discover external stories (network). Resilient: offline → 0, brief still runs.
    const disc = await recordRun("discovery", undefined, () => discover(EXTERNAL_LIMIT));
    await patchState({ lastDiscoveryAt: new Date() });
    console.log(`📡 discovery: ${disc.createdIds.length} new (scanned ${disc.scanned}, ${disc.feedsOk} feeds ok)`);

    // 2. Stage today's personal brief from the private graph (offline).
    const briefId = await proposePersonalBrief(nr);
    if (briefId) console.log("📓 personal brief queued");

    // 3. Run each queued article through the full pipeline.
    const ids = [...disc.createdIds, ...(briefId ? [briefId] : [])];
    if (ids.length === 0) {
      console.log("nothing new to publish (already seeded today, and discovery found nothing).");
    }
    for (const id of ids) {
      const a = await prisma.article.findUniqueOrThrow({ where: { id } });
      console.log(`\n📰 [${a.section}] ${a.headline.slice(0, 70)}`);
      await runPipeline(nr, id);
      const done = await prisma.article.findUniqueOrThrow({ where: { id }, include: { sources: true, claims: true } });
      console.log(`   → ${done.stage}  /${done.date}/${done.slug}  (${done.sources.length} sources, ${done.claims.length} claims, hero: ${done.heroImagePath ? "yes" : "no"})`);
    }

    const published = await prisma.article.count({ where: { date: today(), stage: "PUBLISHED" } });
    console.log(`\n✅ edition ${today()}: ${published} published article(s).`);
  } finally {
    await closeNewsroom(nr);
    await patchState({ status: DaemonStatus.IDLE });
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("❌ seed failed:", err);
  process.exit(1);
});
