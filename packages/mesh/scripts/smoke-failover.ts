/**
 * Verification (Part B): failover provider selection + the 2-process min-bar.
 *
 *   npm run smoke:failover            # pure-logic assertions (fast, no models)
 *   npm run smoke:failover hub        # provider process for the live 2-proc demo
 *   # edge: just use `npm run ask -- "<q>" <hub-pubkey> <invite>` against the hub above,
 *   #       then kill the hub and re-run to observe failover → local (degraded).
 *
 * Gate (committed): the pure-logic block below. The hub process is the documented
 * 2-process min-bar demo (kill the only provider → edge degrades to a cited LOCAL
 * council answer; the edge audit log shows the {phase:"failover", to:"local"} decision).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuditLog, makeCapability } from "@mycelium/shared";
import { MeshGraph, startHeartbeat, startProvider, liveProviders } from "../src/index.ts";
import { close } from "@qvac/sdk";

const here = dirname(fileURLToPath(import.meta.url));
const role = process.argv[2] as "hub" | "edge" | undefined;

function pureLogicGate(): void {
  const now = 1_000_000;
  const fresh = makeCapability({ deviceId: "A", displayName: "plugged-mac", computeClass: "mac", ramMB: 65536, powerState: "plugged", availableModels: [], isProvider: true, providerPublicKey: "PK_A", lastSeen: new Date(now - 5_000).toISOString() });
  const weaker = makeCapability({ deviceId: "B", displayName: "battery-pi", computeClass: "pi", ramMB: 4096, powerState: "battery", availableModels: [], isProvider: true, providerPublicKey: "PK_B", lastSeen: new Date(now - 5_000).toISOString() });
  const stale = makeCapability({ deviceId: "C", displayName: "dead-mac", computeClass: "mac", ramMB: 65536, powerState: "plugged", availableModels: [], isProvider: true, providerPublicKey: "PK_C", lastSeen: new Date(now - 60_000).toISOString() });
  const consumer = makeCapability({ deviceId: "D", displayName: "phone", computeClass: "phone", ramMB: 6144, powerState: "battery", availableModels: [], isProvider: false, lastSeen: new Date(now - 1_000).toISOString() });

  const ranked = liveProviders([weaker, fresh, stale, consumer], { now, staleMs: 30_000 });
  const keys = ranked.map((c) => c.providerPublicKey);
  // stale (C) filtered out; consumer (D) filtered out; A (plugged) ranks above B (battery).
  if (keys.length !== 2) throw new Error(`expected 2 live providers, got ${keys.length}: ${keys.join(",")}`);
  if (keys[0] !== "PK_A" || keys[1] !== "PK_B") throw new Error(`bad ordering: ${keys.join(",")}`);

  const allDead = liveProviders([stale], { now, staleMs: 30_000 });
  if (allDead.length !== 0) throw new Error(`expected 0 live providers when all stale, got ${allDead.length}`);

  console.log("✅ liveProviders: stale + non-providers filtered; plugged ranks above battery; all-stale → empty (→ local fallback)");
}

if (!role) {
  try { pureLogicGate(); console.log("\n✅ FAILOVER LOGIC GO"); process.exit(0); }
  catch (e) { console.error("❌ failover logic failed:", e); process.exit(1); }
} else if (role === "hub") {
  const LOG_DIR = join(here, "..", "logs");
  const audit = new AuditLog("failover-hub", LOG_DIR);
  const dir = join(LOG_DIR, "failover-hub-store");
  const g = await MeshGraph.open({ storeDir: dir, audit });
  await g.joinSwarm();
  const { publicKey } = await startProvider({ audit });
  const hb = startHeartbeat(g, { deviceId: g.localWriterKey, displayName: "failover-hub", computeClass: "mac", ramMB: 65536, powerState: "plugged", availableModels: ["QWEN3_4B_INST_Q4_K_M"], isProvider: true, providerPublicKey: publicKey }, 10_000);
  const inv = await g.mintInvite();
  console.log(`\n📡 provider: ${publicKey}\n🔗 INVITE: ${inv}\n\nedge: npm run ask -- "Which model does Dani run on the Pi, and why?" ${publicKey} ${inv}\n\n(Kill THIS process mid-edge-run to force failover-to-local.)`);
  process.on("SIGINT", () => { hb.stop(); void g.close().then(() => { void close(); process.exit(0); }); });
  process.stdin.resume();
} else {
  console.error("usage: npm run smoke:failover [hub]   (edge side uses `npm run ask`)");
  process.exit(1);
}

export { pureLogicGate };
