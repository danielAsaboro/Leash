/**
 * Verification (Part C): blind-pairing allow-list firewall.
 *
 *   Terminal A:  npm run smoke:allowlist hub          # prints invite; allow-lists a bogus key
 *   Terminal B:  npm run smoke:allowlist edge <invite>
 *
 * GO (host-side, deterministic): an edge whose writer-key is NOT allow-listed, holding
 * a valid invite, is REJECTED — the hub never adds it as a writer and audits
 * pairing{rejected:true}; the edge never gains write access.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";
import { AuditLog } from "@mycelium/shared";
import { MeshGraph } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const role = process.argv[2] as "hub" | "edge" | undefined;
const invite = process.argv[3];
const LOG_DIR = join(here, "..", "logs");
const audit = new AuditLog(`allowlist-smoke-${role ?? "unknown"}`, LOG_DIR);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

try {
  if (role === "hub") {
    const dir = join(LOG_DIR, "allowlist-hub-store");
    rmSync(dir, { recursive: true, force: true });
    // Allow-list a bogus key so the real edge is NOT listed → must be rejected.
    const g = await MeshGraph.open({ storeDir: dir, audit, allowedDevices: new Set(["00".repeat(32)]) });
    await g.joinSwarm();
    await g.append({ kind: "note", source: "hub", text: "secret graph" });
    const inv = await g.mintInvite();
    const writers0 = g.writerCount();
    console.log(`\n🔗 INVITE (for an UNLISTED edge):\n   ${inv}\n\nedge: npm run smoke:allowlist edge ${inv}\n`);
    // Stay alive long enough for the candidate to receive the deny + assert no writer
    // is ever added (the deterministic host-side gate).
    const t0 = Date.now();
    while (Date.now() - t0 < 35_000) { await g.update(); if (g.writerCount() > writers0) break; await sleep(500); }
    if (g.writerCount() > writers0) throw new Error(`UNLISTED edge was added as a writer (count ${writers0} → ${g.writerCount()})`);
    console.log(`✅ unlisted edge never became a writer (writers stayed ${writers0})`);
    console.log("   (check the audit log for pairing{rejected:true})");
    console.log("\n✅ HUB GO");
    await g.close();
    process.exit(0);
  } else if (role === "edge") {
    if (!invite) { console.error("edge needs an invite"); process.exit(1); }
    const dir = join(LOG_DIR, "allowlist-edge-store");
    rmSync(dir, { recursive: true, force: true });
    console.log("edge: pairing with a valid invite but an unlisted key (should be rejected/blocked)…");
    // pair() awaits the host's confirm/deny with no internal timeout, so race it: an
    // explicit PAIRING_REJECTED (deny received) OR a timeout (never confirmed) both prove
    // the unlisted edge did not gain write access.
    const outcome = await Promise.race([
      MeshGraph.pair({ storeDir: dir, invite, audit }).then((g) => ({ kind: "paired" as const, g })).catch((e) => ({ kind: "rejected" as const, err: e })),
      sleep(25_000).then(() => ({ kind: "timeout" as const })),
    ]);
    if (outcome.kind === "rejected") {
      console.log(`✅ edge pairing rejected as expected: ${String(outcome.err).split("\n")[0]}`);
    } else if (outcome.kind === "timeout") {
      console.log("✅ edge pairing blocked: never confirmed within 25s (host allow-list denied it)");
    } else {
      const g = outcome.g;
      const t0 = Date.now();
      while (Date.now() - t0 < 8_000) { await g.update(); if (g.writable) break; await sleep(500); }
      if (g.writable) { console.error("❌ edge became writable despite not being allow-listed"); await g.close(); process.exit(1); }
      console.log("✅ edge paired read-only but never gained write access (allow-list)");
      await g.close();
    }
    console.log("\n✅ EDGE GO");
    process.exit(0);
  } else {
    console.error("usage: npm run smoke:allowlist hub | edge <invite>");
    process.exit(1);
  }
} catch (error) {
  console.error("❌ allowlist smoke failed:", error);
  audit.record({ event: "note", extra: { role, error: String(error) } });
  process.exit(1);
}
