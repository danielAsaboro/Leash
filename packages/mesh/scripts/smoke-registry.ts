/**
 * Verification (Part A): capability-registry P2P gossip over the CRDT mesh.
 *
 *   Terminal A:  npm run smoke:registry hub
 *   Terminal B:  npm run smoke:registry edge <invite>
 *
 * GO: hub advertises a DeviceCapability; edge pairs, replicates it, sees the hub's
 * cap (deviceId, isProvider, providerPublicKey), and a CapabilityRegistry fed from
 * the edge's replicated caps returns the HUB from bestProvider(). Runs offline.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";
import { AuditLog, makeCapability } from "@mycelium/shared";
import { MeshGraph, CapabilityRegistry } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const role = process.argv[2] as "hub" | "edge" | undefined;
const invite = process.argv[3];
const LOG_DIR = join(here, "..", "logs");
const audit = new AuditLog(`registry-smoke-${role ?? "unknown"}`, LOG_DIR);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(label: string, fn: () => Promise<boolean>, ms = 30_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) { console.log(`✅ ${label}`); return; } await sleep(500); }
  throw new Error(`timed out: ${label}`);
}

try {
  if (role === "hub") {
    const dir = join(LOG_DIR, "registry-hub-store");
    rmSync(dir, { recursive: true, force: true });
    const g = await MeshGraph.open({ storeDir: dir, audit });
    await g.joinSwarm();
    await g.advertise(makeCapability({
      deviceId: g.localWriterKey, displayName: "hub-mac", computeClass: "mac", ramMB: 65536,
      powerState: "plugged", availableModels: ["QWEN3_4B_INST_Q4_K_M"], isProvider: true,
      providerPublicKey: "HUBPROVIDERPUBKEY",
    }));
    const inv = await g.mintInvite();
    console.log(`\n🔗 INVITE:\n   ${inv}\n\nedge: npm run smoke:registry edge ${inv}\n`);
    await waitFor("edge cap replicated to hub", async () => (await g.capabilities()).some((c) => !c.isProvider));
    console.log(`hub sees ${(await g.capabilities()).length} caps`);
    console.log("\n✅ HUB GO");
    await sleep(2000);
    await g.close();
    process.exit(0);
  } else if (role === "edge") {
    if (!invite) { console.error("edge needs an invite"); process.exit(1); }
    const dir = join(LOG_DIR, "registry-edge-store");
    rmSync(dir, { recursive: true, force: true });
    const g = await MeshGraph.pair({ storeDir: dir, invite, audit });
    await waitFor("edge promoted to writer", async () => { await g.update(); return g.writable; });
    await g.advertise(makeCapability({
      deviceId: g.localWriterKey, displayName: "edge-phone", computeClass: "phone", ramMB: 6144,
      powerState: "battery", availableModels: ["QWEN3_600M_INST_Q4"], isProvider: false,
    }));
    await waitFor("hub cap replicated to edge", async () => (await g.capabilities()).some((c) => c.isProvider));
    const caps = await g.capabilities();
    const reg = new CapabilityRegistry();
    caps.forEach((c) => reg.register(c));
    const best = reg.bestProvider();
    console.log(`edge sees ${caps.length} caps; bestProvider = ${best?.displayName} (provider=${best?.isProvider}, pubkey=${best?.providerPublicKey})`);
    if (!best?.isProvider || best.providerPublicKey !== "HUBPROVIDERPUBKEY") throw new Error("bestProvider did not select the replicated hub");
    console.log("\n✅ EDGE GO");
    await sleep(6000);
    await g.close();
    process.exit(0);
  } else {
    console.error("usage: npm run smoke:registry hub | npm run smoke:registry edge <invite>");
    process.exit(1);
  }
} catch (error) {
  console.error("❌ registry smoke failed:", error);
  audit.record({ event: "note", extra: { role, error: String(error) } });
  process.exit(1);
}
