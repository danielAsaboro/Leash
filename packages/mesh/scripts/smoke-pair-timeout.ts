/**
 * Smoke: joiner pairing timeout (the "stuck at Pairing with X…" regression).
 *
 *   npx tsx packages/mesh/scripts/smoke-pair-timeout.ts
 *
 * Reproduces the silent-stuck failure: a valid invite whose host is GONE (closed right
 * after minting — same observable shape as a host whose onadd errors without deny).
 * Pre-fix, `MeshGraph.pair` awaited `candidate.pairing` forever. GO when pair() THROWS
 * within the deadline (plus slack) instead of hanging, leaving no open store behind.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";
import { MeshGraph } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const hubDir = join(here, "..", "logs", "pair-timeout-hub-store");
const edgeDir = join(here, "..", "logs", "pair-timeout-edge-store");

try {
  rmSync(hubDir, { recursive: true, force: true });
  rmSync(edgeDir, { recursive: true, force: true });

  // Mint a real invite, then take the host away — nobody will ever confirm the candidate.
  const hub = await MeshGraph.open({ storeDir: hubDir });
  await hub.joinSwarm();
  const invite = await hub.mintInvite();
  await hub.close();

  const TIMEOUT_MS = 5_000;
  const t0 = Date.now();
  let threw: Error | null = null;
  try {
    await MeshGraph.pair({ storeDir: edgeDir, invite, timeoutMs: TIMEOUT_MS });
  } catch (err) {
    threw = err as Error;
  }
  const elapsed = Date.now() - t0;

  if (!threw) throw new Error("FAILED: pair() resolved against a dead host (it must throw)");
  console.log(`✅ pair() threw instead of hanging (${elapsed}ms): ${threw.message.slice(0, 80)}…`);
  if (elapsed > TIMEOUT_MS + 10_000) throw new Error(`FAILED: took ${elapsed}ms — timeout didn't bound the wait`);
  console.log("✅ wait was bounded by timeoutMs (+ cleanup slack)");

  // Cleanup ran: the edge store must be closed (reopenable without a lock error).
  const reopened = await MeshGraph.open({ storeDir: edgeDir });
  await reopened.close();
  console.log("✅ edge store closed cleanly (reopen works)");

  rmSync(hubDir, { recursive: true, force: true });
  rmSync(edgeDir, { recursive: true, force: true });
  console.log("\n✅ PAIR-TIMEOUT SMOKE GO");
  process.exit(0);
} catch (error) {
  console.error("❌ pair-timeout smoke failed:", error);
  process.exit(1);
}
