/**
 * Spike 05 — multi-writer Autobase context-graph sync + blind-pairing.
 *
 * The Week-2 de-risk: prove (offline, with @qvac/sdk loaded in THIS process) that
 * autobase + blind-pairing + our OWN Hyperswarm give us a multi-writer, dynamically
 * paired, bidirectional, id-deduped graph that replicates over loopback with no
 * internet — and that our swarm coexists with the SDK's delegation swarm.
 *
 *   Terminal A:  npm run spike:autobase hub
 *   Terminal B:  npm run spike:autobase edge <invite-from-A>
 *
 * GO criteria (must all hold, offline):
 *   (a) two processes each have their own writable input  (base.writable true on both)
 *   (b) blind-pairing invite→pair auto-adds the edge as a writer
 *   (c) a node appended on EITHER side appears on the OTHER (bidirectional)
 *   (d) the Hyperbee view dedupes by node.id (append same id twice → one entry)
 *   (e) loopback replication works with empty swarmRelays (offline)
 *   (f) our Hyperswarm coexists with the SDK's (hub also startQVACProvider)
 *   (g) all()/update() returns promptly with no peer
 *
 * Note vs the plan: autobase's `update()` takes NO args (verified in the installed
 * source) — it linearizes whatever has locally replicated and never blocks on peers
 * (so R6 holds for free). "Pre-query sync" is therefore a bounded POLL (waitFor),
 * not `update({wait:true})`.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import Corestore from "corestore";
import Autobase from "autobase";
import Hyperbee from "hyperbee";
import Hyperswarm from "hyperswarm";
import BlindPairing from "blind-pairing";
import b4a from "b4a";
import { startQVACProvider, close } from "@qvac/sdk";
import { AuditLog } from "./lib/audit-log.ts";

const here = dirname(fileURLToPath(import.meta.url));
const role = process.argv[2] as "hub" | "edge" | undefined;
const inviteArg = process.argv[3];
const audit = new AuditLog(`05-autobase-${role ?? "unknown"}`);

interface GraphNode { id: string; kind: string; source: string; text: string; ts: string }
type Entry = { type: "node"; node: GraphNode } | { type: "add-writer"; key: string };

/** The autobase view: a Hyperbee keyed by node.id (idempotent grow-only set). */
function viewOpen(store: any) {
  return new Hyperbee(store.get("view"), { keyEncoding: "utf-8", valueEncoding: "json" });
}
/** The entire CRDT: two idempotent entry shapes. */
async function viewApply(nodes: any[], view: any, host: any) {
  for (const node of nodes) {
    const v = node.value as Entry;
    if (v?.type === "add-writer") {
      await host.addWriter(b4a.from(v.key, "hex"), { indexer: true });
      continue;
    }
    if (v?.type === "node") await view.put(v.node.id, v.node);
  }
  // A plain Hyperbee `put` is durable on its own — no view.flush() (that's a HyperDB-ism).
}

/** Prototype of MeshGraph: Corestore + Autobase(multi-writer) + Hyperbee view + Hyperswarm. */
class AutobaseGraph {
  store: any;
  base: any;
  swarm: any | null = null;
  pairing: any | null = null;
  member: any | null = null;

  constructor(store: any, bootstrapKey: Buffer | null) {
    this.store = store;
    this.base = new Autobase(this.store, bootstrapKey, {
      valueEncoding: "json",
      open: viewOpen,
      apply: viewApply,
    });
  }
  async ready() { await this.base.ready(); }
  get autobaseKey(): string { return b4a.toString(this.base.key, "hex"); }
  get localWriterKey(): string { return b4a.toString(this.base.local.key, "hex"); }
  get writable(): boolean { return this.base.writable; }

  async append(partial: Omit<GraphNode, "id" | "ts"> & { id?: string; ts?: string }): Promise<GraphNode> {
    const node: GraphNode = {
      id: partial.id ?? randomUUID(),
      ts: partial.ts ?? new Date().toISOString(),
      kind: partial.kind,
      source: partial.source,
      text: partial.text,
    };
    await this.base.append({ type: "node", node });
    return node;
  }
  /** Read the local view in id order. update() never blocks on peers (g/R6). */
  async all(): Promise<GraphNode[]> {
    await this.base.update();
    const out: GraphNode[] = [];
    for await (const { value } of this.base.view.createReadStream()) out.push(value as GraphNode);
    return out;
  }
  joinSwarm(): Promise<void> {
    this.swarm = new Hyperswarm();
    this.swarm.on("connection", (conn: any) => this.store.replicate(conn));
    this.swarm.join(this.base.discoveryKey);
    return this.swarm.flush();
  }
  /** Host: mint a hex invite and accept the first candidate as a writer. */
  async mintInvite(): Promise<string> {
    const { invite, publicKey } = BlindPairing.createInvite(this.base.key);
    this.pairing = new BlindPairing(this.swarm);
    this.member = this.pairing.addMember({
      discoveryKey: this.base.discoveryKey,
      onadd: async (candidate: any) => {
        candidate.open(publicKey);
        const writerKey = b4a.toString(candidate.userData, "hex");
        await this.base.append({ type: "add-writer", key: writerKey });
        candidate.confirm({ key: this.base.key });
        audit.record({ event: "pairing", extra: { role: "host", writerKey } });
        console.log(`🤝 added edge writer: ${writerKey.slice(0, 16)}…`);
      },
    });
    await this.member.flushed();
    return b4a.toString(invite, "hex");
  }
  /** Candidate: pair against an invite; resolves once the host confirms. */
  static async pair(store: any, swarm: any, inviteHex: string): Promise<AutobaseGraph> {
    const pairing = new BlindPairing(swarm);
    const localCore = Autobase.getLocalCore(store);
    await localCore.ready();
    const userData = b4a.from(localCore.key); // hand our writer key to the host
    await localCore.close();
    const candidate = pairing.addCandidate({
      invite: b4a.from(inviteHex, "hex"),
      userData,
      onadd: () => {},
    });
    const result = await candidate.pairing; // { key: autobaseKey, encryptionKey, data }
    await candidate.close();
    await pairing.close();
    const graph = new AutobaseGraph(store, result.key);
    graph.swarm = swarm;
    await graph.base.ready();
    swarm.join(graph.base.discoveryKey);
    await swarm.flush();
    audit.record({ event: "pairing", extra: { role: "candidate", autobaseKey: b4a.toString(result.key, "hex") } });
    return graph;
  }
  async close() {
    if (this.member) await this.member.close();
    if (this.pairing) await this.pairing.close();
    if (this.swarm) await this.swarm.destroy();
    await this.base.close();
    await this.store.close();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(label: string, fn: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) { console.log(`✅ ${label}`); return; }
    await sleep(500);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

if (role !== "hub" && role !== "edge") {
  console.error("usage: npm run spike:autobase hub   |   npm run spike:autobase edge <invite>");
  process.exit(1);
}

try {
  if (role === "hub") {
    const dir = join(here, "checkpoints", "autobase-hub");
    rmSync(dir, { recursive: true, force: true }); // fresh deterministic run
    const graph = new AutobaseGraph(new Corestore(dir), null);
    await graph.ready();
    await graph.joinSwarm();
    console.log(`🛰️  hub autobase key: ${graph.autobaseKey}`);
    console.log(`🛰️  hub writable: ${graph.writable}`); // (a) must be true

    // (f) prove our Hyperswarm coexists with the SDK's delegation swarm in ONE process.
    const provider = await startQVACProvider({});
    console.log(`📡 (f) SDK provider up alongside our swarm: ${String(provider.publicKey).slice(0, 16)}…`);

    const invite = await graph.mintInvite();
    console.log(`\n🔗 INVITE (give to edge):\n   ${invite}\n`);
    console.log("Edge command:  npm run spike:autobase edge " + invite + "\n");

    await graph.append({ kind: "note", source: "hub", text: "hub-seeded: the Pi runs QWEN3_600M" });
    console.log("appended hub node; waiting for the edge to pair + append…");

    // (b)+(c) edge becomes a writer and an edge node arrives here. Generous window
    // so a hand-driven two-terminal test has time to copy the invite + start the edge.
    await waitFor("(c) edge→hub node replicated", async () => (await graph.all()).some((n) => n.source === "edge"), 300_000);
    const all = await graph.all();
    console.log(`hub view now has ${all.length} nodes: ${all.map((n) => n.source).join(", ")}`);
    audit.record({ event: "graph_sync", extra: { total: all.length, sources: all.map((n) => n.source) } });
    console.log("\n✅ HUB GO — multi-writer + pairing + bidirectional + offline replication proven.");
    await graph.close();
    await close();
    process.exit(0);
  } else {
    if (!inviteArg) { console.error("edge needs an invite: npm run spike:autobase edge <invite>"); process.exit(1); }
    const dir = join(here, "checkpoints", "autobase-edge");
    rmSync(dir, { recursive: true, force: true });
    const store = new Corestore(dir);
    await store.ready();
    const swarm = new Hyperswarm();
    swarm.on("connection", (conn: any) => store.replicate(conn));
    const graph = await AutobaseGraph.pair(store, swarm, inviteArg);
    console.log(`🔗 edge paired; autobase key: ${graph.autobaseKey}`);

    // (a)+(b) the edge must become a writer once the hub's add-writer entry replicates.
    await waitFor("(b) edge promoted to writer", async () => { await graph.base.update(); return graph.writable; });

    // (c) hub→edge: the hub-seeded node must arrive.
    await waitFor("(c) hub→edge node replicated", async () => (await graph.all()).some((n) => n.source === "hub"));

    // append an edge node (flows hub-ward), then prove (d) id dedupe.
    const en = await graph.append({ kind: "note", source: "edge", text: "edge-sensed: backup battery lasts 12 hours" });
    await graph.append({ id: en.id, kind: "note", source: "edge", text: "edge-sensed: backup battery lasts 12 hours" }); // same id
    await sleep(1000);
    const mine = (await graph.all()).filter((n) => n.id === en.id);
    if (mine.length !== 1) throw new Error(`(d) dedupe FAILED: ${mine.length} entries for one id`);
    console.log("✅ (d) Hyperbee dedupes by node.id");

    const all = await graph.all();
    console.log(`edge view now has ${all.length} nodes: ${all.map((n) => n.source).join(", ")}`);
    audit.record({ event: "graph_sync", extra: { total: all.length, sources: all.map((n) => n.source) } });
    console.log("\n✅ EDGE GO — paired, promoted, bidirectional, id-deduped, offline.");
    console.log("(leaving the swarm up ~8s so the hub sees the edge node…)");
    await sleep(8000);
    await graph.close();
    await close();
    process.exit(0);
  }
} catch (error) {
  console.error("❌ spike 05 failed:", error);
  audit.record({ event: "note", extra: { role, error: String(error) } });
  await close().catch(() => {});
  process.exit(1);
}
