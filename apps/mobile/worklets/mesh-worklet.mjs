/**
 * Bare worklet — the phone as a REAL private-mesh member. Runs a Corestore + multi-writer
 * Autobase + a Hyperbee view + its own Hyperswarm + blind-pairing INSIDE react-native-bare-kit
 * (the proven forward-worklet.mjs pattern), so the iPhone replicates the same task CRDT as the
 * desktops — not a thin delegated-inference client. It INLINES the @mycelium/mesh logic (mesh-graph.ts
 * viewApply + task/leader methods) because apps/mobile is workspace-excluded; the deps
 * (corestore/autobase/hyperbee/hyperswarm/blind-pairing) are bundled by bare-pack against the
 * vendored native xcframeworks (rocksdb/sodium/udx/…).
 *
 * RN → worklet (newline-JSON, mirrors forward-worklet framing):
 *   { id, cmd:"init",  storeDir, displayName? }     → open/recover the mesh, start swarm+heartbeat
 *   { id, cmd:"join",  invite }                      → blind-pair into a desktop's mesh (the invite IS the cap)
 *   { id, cmd:"tasks.list" }                         → { tasks:[…] }
 *   { id, cmd:"tasks.upsert", task }                 → { task }
 *   { id, cmd:"tasks.delete", id:taskId, ts? }       → { ok:true }
 *   { id, cmd:"status" }                             → { joined, writable, peers, leader, deviceId }
 * worklet → RN:
 *   { type:"reply", id, ok, … } | { type:"error", id, error } | { type:"event", ev:"tasks.changed" } | { type:"ready" }
 */
import Corestore from "corestore";
import Autobase from "autobase";
import Hyperbee from "hyperbee";
import Hyperswarm from "hyperswarm";
import BlindPairing from "blind-pairing";
import b4a from "b4a";
import fs from "bare-fs";

const IPC = BareKit.IPC;
const out = (o) => IPC.write(b4a.from(JSON.stringify(o) + "\n"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the CRDT (ported from packages/mesh/src/mesh-graph.ts) ──────────────────────────────────────
function viewOpen(store) {
  return new Hyperbee(store.get("view"), { keyEncoding: "utf-8", valueEncoding: "json" });
}
async function viewApply(nodes, view, host) {
  const bee = view;
  for (const { value } of nodes) {
    if (value?.type === "add-writer") { await host.addWriter(b4a.from(value.key, "hex"), { indexer: true }); continue; }
    if (value?.type === "node") { await bee.put("node:" + value.node.id, value.node); continue; }
    if (value?.type === "capability") { await bee.put("cap:" + value.cap.deviceId, value.cap); continue; }
    if (value?.type === "task") {
      const existing = await bee.get("task:" + value.task.id);
      if (!existing?.value || value.task.updatedAt >= existing.value.updatedAt) await bee.put("task:" + value.task.id, value.task);
      continue;
    }
    if (value?.type === "task-delete") {
      const existing = await bee.get("task:" + value.id);
      if (!existing?.value || value.ts >= existing.value.updatedAt) {
        const base = existing?.value ?? { id: value.id, title: "", status: "dropped", priority: "normal", tags: [], source: "", createdAt: value.ts };
        await bee.put("task:" + value.id, { ...base, id: value.id, deleted: true, updatedAt: value.ts });
      }
      continue;
    }
  }
}

// ── worklet state ────────────────────────────────────────────────────────────────────────────────
let store = null;       // root corestore (replicated over the swarm)
let meshStore = null;   // the CURRENT mesh's namespace within `store` (one per join — clean re-join)
let base = null;
let swarm = null;
let storeDir = null;
let displayName = "iPhone";
let joinedAt = 0;
let gen = 0;            // join generation → namespace "mesh-<gen>"; bumped on each join so a new mesh
                        // never collides with a previous base's view/writer (the phone is single-mesh)
let hbTimer = null;
let changeTimer = null;
let lastTaskSig = "";

const metaPath = () => storeDir + "/mesh-meta.json";
function readMeta() {
  try { return JSON.parse(b4a.toString(fs.readFileSync(metaPath()))); } catch { return {}; }
}
function writeMeta(m) {
  try { fs.writeFileSync(metaPath(), b4a.from(JSON.stringify(m))); } catch { /* best-effort */ }
}

/** Stand the mesh up on `base`: join the swarm, start the heartbeat, watch the view for task changes. */
async function bringOnline() {
  if (swarm) return;
  swarm = new Hyperswarm();
  swarm.on("connection", (conn) => { conn.on("error", () => {}); store.replicate(conn); });
  swarm.join(base.discoveryKey);
  await swarm.flush().catch(() => {});
  await advertise();
  hbTimer = setInterval(() => void advertise(), 15_000);
  // Poll the linearized view; when the non-deleted task set changes, nudge RN to re-list.
  changeTimer = setInterval(() => void pollTasksChanged(), 1500);
}

async function advertise() {
  if (!base?.writable) return;
  const cap = { deviceId: base.local ? b4a.toString(base.local.key, "hex") : "", displayName, computeClass: "phone", isProvider: false, joinedAt, lastSeen: new Date().toISOString() };
  await base.append({ type: "capability", cap }).catch(() => {});
}

async function pollTasksChanged() {
  try {
    await base.update();
    const tasks = await readTasks();
    const sig = tasks.map((t) => t.id + ":" + t.updatedAt).join("|");
    if (sig !== lastTaskSig) { lastTaskSig = sig; out({ type: "event", ev: "tasks.changed" }); }
  } catch { /* transient */ }
}

/** Non-deleted tasks (for the change-detection signature). */
async function readTasks() {
  return (await readAllTasks()).filter((t) => !t.deleted);
}

/** Every task INCLUDING tombstones — so the RN side can LWW-merge + apply remote deletes locally. */
async function readAllTasks() {
  await base.update();
  const out2 = [];
  for await (const { value } of base.view.createReadStream({ gte: "task:", lt: "task;" })) out2.push(value);
  return out2.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function readCaps() {
  await base.update();
  const caps = [];
  for await (const { value } of base.view.createReadStream({ gte: "cap:", lt: "cap;" })) caps.push(value);
  return caps;
}

/** The derived oldest-active-member leader (smallest joinedAt among live caps; deviceId tiebreak). */
async function leader(staleMs = 30_000) {
  const now = Date.now();
  const live = (await readCaps()).filter((c) => typeof c.joinedAt === "number" && Number.isFinite(Date.parse(c.lastSeen)) && now - Date.parse(c.lastSeen) <= staleMs);
  if (!live.length) return null;
  live.sort((a, b) => (a.joinedAt - b.joinedAt) || (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0));
  return live[0].deviceId;
}

// ── lifecycle ─────────────────────────────────────────────────────────────────────────────────
async function openRecovered() {
  // A previously-paired namespace recovers its writable base via the local core's referrer (no key).
  base = new Autobase(meshStore, null, { valueEncoding: "json", open: viewOpen, apply: viewApply });
  await base.ready();
  await bringOnline();
}

/** Tear the current mesh down (close base + swarm + timers) so a fresh join can't collide with it. */
async function resetForJoin() {
  if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
  if (changeTimer) { clearInterval(changeTimer); changeTimer = null; }
  if (swarm) { try { await swarm.destroy(); } catch { /* ignore */ } swarm = null; }
  if (base) { try { await base.close(); } catch { /* ignore */ } base = null; }
  lastTaskSig = "";
  gen += 1;
  meshStore = store.namespace("mesh-" + gen); // a clean namespace for the new mesh
}

async function pair(invite) {
  // Joining a mesh REPLACES any current one (single-mesh phone): reset to a fresh namespace first.
  await resetForJoin();
  // Blind-pairing candidate flow (mesh-graph.ts MeshGraph.pair, inlined). The invite is the capability;
  // the host promotes us to a writer (its add-writer entry replicates in shortly after).
  const pairSwarm = new Hyperswarm();
  pairSwarm.on("connection", (conn) => { conn.on("error", () => {}); store.replicate(conn); });
  const pairing = new BlindPairing(pairSwarm);
  const localCore = Autobase.getLocalCore(meshStore);
  await localCore.ready();
  const userData = b4a.from(localCore.key);
  await localCore.close();
  const candidate = pairing.addCandidate({ invite: b4a.from(invite, "hex"), userData, onadd: () => {} });
  const result = await candidate.pairing; // resolves when the host confirms (rejects on deny)
  await candidate.close();
  await pairing.close();
  await pairSwarm.destroy().catch(() => {});

  base = new Autobase(meshStore, result.key, { valueEncoding: "json", open: viewOpen, apply: viewApply });
  await base.ready();
  if (!joinedAt) joinedAt = Date.now();
  writeMeta({ joined: true, joinedAt, gen });
  await bringOnline();
  // Poll until the host's add-writer replicates and we become writable (bounded).
  const t0 = Date.now();
  while (!base.writable && Date.now() - t0 < 30_000) { await base.update(); if (base.writable) break; await sleep(500); }
  await advertise();
}

// ── IPC dispatch ────────────────────────────────────────────────────────────────────────────────
async function handle(req) {
  const reply = (o) => out({ type: "reply", id: req.id, ok: true, ...o });
  try {
    switch (req.cmd) {
      case "init": {
        storeDir = req.storeDir;
        if (req.displayName) displayName = req.displayName;
        store = new Corestore(storeDir, { allowBackup: true });
        await store.ready();
        const meta = readMeta();
        joinedAt = typeof meta.joinedAt === "number" ? meta.joinedAt : 0;
        gen = typeof meta.gen === "number" ? meta.gen : 0;
        meshStore = store.namespace("mesh-" + gen);
        if (meta.joined) await openRecovered(); // mesh-less until the first join otherwise
        return reply({ joined: !!base });
      }
      case "join": {
        if (!store) throw new Error("call init before join");
        if (!req.invite) throw new Error("an invite is required");
        await pair(req.invite);
        return reply({ joined: true, writable: !!base?.writable });
      }
      case "tasks.list":
        // Returns tombstones too (the RN side LWW-merges them into its local cache).
        return reply({ tasks: base ? await readAllTasks() : [] });
      case "tasks.upsert": {
        if (!base) throw new Error("not in a mesh yet — scan an invite first");
        if (!base.writable) throw new Error("mesh not writable yet (still syncing)");
        const now = Date.now();
        const t = req.task || {};
        const task = {
          id: t.id, title: t.title ?? "", ...(t.detail !== undefined ? { detail: t.detail } : {}),
          status: t.status ?? "open", priority: t.priority ?? "normal", tags: t.tags ?? [],
          source: t.source ?? "user", createdAt: t.createdAt ?? now, updatedAt: t.updatedAt ?? now,
        };
        await base.append({ type: "task", task });
        return reply({ task });
      }
      case "tasks.delete": {
        if (!base) throw new Error("not in a mesh yet");
        if (!base.writable) throw new Error("mesh not writable yet (still syncing)");
        await base.append({ type: "task-delete", id: req.id, ts: req.ts ?? Date.now() });
        return reply({ ok: true });
      }
      case "status": {
        const deviceId = base?.local ? b4a.toString(base.local.key, "hex") : null;
        return reply({ joined: !!base, writable: !!base?.writable, peers: swarm ? swarm.connections.size : 0, leader: base ? await leader() : null, deviceId });
      }
      default:
        throw new Error("unknown cmd: " + req.cmd);
    }
  } catch (err) {
    out({ type: "error", id: req.id, error: err?.message || String(err) });
  }
}

let inbuf = "";
IPC.on("data", (chunk) => {
  inbuf += b4a.toString(chunk);
  const parts = inbuf.split("\n");
  inbuf = parts.pop() || "";
  for (const line of parts) {
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    void handle(req);
  }
});

out({ type: "ready" });
