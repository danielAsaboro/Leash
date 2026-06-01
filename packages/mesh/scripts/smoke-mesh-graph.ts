/**
 * Verification (build step 4): MeshGraph swarm + blind-pairing, through the package
 * API (re-proves spike 05's assertions via @mycelium/mesh, not the prototype).
 *
 *   Terminal A:  npm run mesh:smoke hub
 *   Terminal B:  npm run mesh:smoke edge <invite>
 *
 * GO: edge pairs → becomes a writer → hub node visible on edge AND edge node visible
 * on hub (bidirectional) → id dedupe holds. Runs offline (loopback).
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
const audit = new AuditLog(`mesh-smoke-${role ?? "unknown"}`, LOG_DIR);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(label: string, fn: () => Promise<boolean>, ms = 30_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) { console.log(`✅ ${label}`); return; } await sleep(500); }
  throw new Error(`timed out: ${label}`);
}

try {
  if (role === "hub") {
    const dir = join(LOG_DIR, "mesh-hub-store");
    rmSync(dir, { recursive: true, force: true });
    const g = await MeshGraph.open({ storeDir: dir, audit });
    await g.joinSwarm();
    await g.append({ kind: "note", source: "hub", text: "hub: the Pi runs QWEN3_600M" });
    const inv = await g.mintInvite();
    console.log(`\n🔗 INVITE:\n   ${inv}\n\nedge: npm run mesh:smoke edge ${inv}\n`);
    await waitFor("edge→hub node replicated", async () => (await g.all()).some((n) => n.source === "edge"));
    console.log(`hub view: ${(await g.all()).map((n) => n.source).join(", ")}`);
    console.log("\n✅ HUB GO");
    await sleep(2000);
    await g.close();
    process.exit(0);
  } else if (role === "edge") {
    if (!invite) { console.error("edge needs an invite"); process.exit(1); }
    const dir = join(LOG_DIR, "mesh-edge-store");
    rmSync(dir, { recursive: true, force: true });
    const g = await MeshGraph.pair({ storeDir: dir, invite, audit });
    await waitFor("edge promoted to writer", async () => { await g.update(); return g.writable; });
    await waitFor("hub→edge node replicated", async () => (await g.all()).some((n) => n.source === "hub"));
    const n = await g.append({ kind: "note", source: "edge", text: "edge: battery lasts 12 hours" });
    await g.append({ id: n.id, kind: "note", source: "edge", text: "edge: battery lasts 12 hours" });
    await sleep(1000);
    const dup = (await g.all()).filter((x) => x.id === n.id);
    if (dup.length !== 1) throw new Error(`dedupe FAILED: ${dup.length}`);
    console.log("✅ id dedupe holds");
    console.log(`edge view: ${(await g.all()).map((x) => x.source).join(", ")}`);
    console.log("\n✅ EDGE GO");
    await sleep(6000);
    await g.close();
    process.exit(0);
  } else {
    console.error("usage: npm run mesh:smoke hub | npm run mesh:smoke edge <invite>");
    process.exit(1);
  }
} catch (error) {
  console.error("❌ mesh smoke failed:", error);
  audit.record({ event: "note", extra: { role, error: String(error) } });
  process.exit(1);
}
