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
let logPath = null; // set in init → a pullable file (devicectl copy from appDataContainer)
const dbg = (...a) => {
  const line = "[mesh-worklet] " + a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n";
  try { console.error(line.trim()); } catch { /* no console */ }
  try { if (logPath) fs.writeFileSync(logPath, line, { flag: "a" }); } catch { /* fs not ready */ }
};
// CRITICAL: Bare aborts the whole process on an unhandled rejection (confirmed via crash report —
// bare_runtime__on_unhandled_rejection → abort). Catch them so a stray rejection logs instead of crashing.
try { process.on?.("uncaughtException", (e) => dbg("UNCAUGHT", e?.stack || String(e))); } catch { /* ignore */ }
try { process.on?.("unhandledRejection", (e) => dbg("UNHANDLED_REJECTION", e?.stack || String(e))); } catch { /* ignore */ }

// ── the CRDT (ported from packages/mesh/src/mesh-graph.ts) ──────────────────────────────────────
function viewOpen(store) {
  return new Hyperbee(store.get("view"), { keyEncoding: "utf-8", valueEncoding: "json" });
}
async function viewApply(nodes, view, host) {
  const bee = view;
  for (const { value } of nodes) {
    // Per-entry try/catch: an apply error must NOT reject (Bare aborts the whole app on an unhandled
    // rejection — confirmed via crash report). Log + skip the bad entry instead.
    try {
      if (value?.type === "add-writer") { dbg("apply: add-writer"); await host.addWriter(b4a.from(value.key, "hex"), { indexer: true }); continue; }
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
      // Skills replicate desktop → phone over the same CRDT (LWW by updatedAt), keyed by slug.
      if (value?.type === "skill") {
        const existing = await bee.get("skill:" + value.skill.slug);
        if (!existing?.value || (value.skill.updatedAt ?? 0) >= (existing.value.updatedAt ?? 0)) await bee.put("skill:" + value.skill.slug, value.skill);
        continue;
      }
      if (value?.type === "skill-delete") {
        const existing = await bee.get("skill:" + value.slug);
        if (!existing?.value || value.ts >= (existing.value.updatedAt ?? 0)) await bee.put("skill:" + value.slug, { slug: value.slug, deleted: true, updatedAt: value.ts });
        continue;
      }
    } catch (e) {
      dbg("apply: ENTRY ERROR type=" + (value && value.type) + " " + (e?.message || String(e)));
    }
  }
}

// ── worklet state ────────────────────────────────────────────────────────────────────────────────
let store = null;       // root corestore — the joiner's autobase opens on THIS root store, the SAME
                        // namespace as the desktop host's Primary mesh (mesh-host.ts storeFor() = root).
                        // A sub-namespace derives the name-based view cores under a different prefix that
                        // never reconciles with the replicated host cores → null.download. Replicated
                        // wholesale over the swarm (store.replicate covers everything).
let base = null;
let swarm = null;
let storeDir = null;
let displayName = "iPhone";
let joinedAt = 0;
let meshLabel = "Private mesh"; // human label shown in the mobile UI; persisted in meta on join
let visibility = "private";     // blind-pairing into a desktop mesh is always private (no public cells on mobile yet)
let hbTimer = null;
let changeTimer = null;
let lastTaskSig = "";
let lastReconnectAt = 0; // throttle the heartbeat reconnect-watchdog (≥30s between re-join attempts)

const metaPath = () => storeDir + "/mesh-meta.json";
function readMeta() {
  try { return JSON.parse(b4a.toString(fs.readFileSync(metaPath()))); } catch { return {}; }
}
function writeMeta(m) {
  try { fs.writeFileSync(metaPath(), b4a.from(JSON.stringify(m))); } catch { /* best-effort */ }
}

// STABLE per-device identity, advertised as `consumerPublicKey` so the desktop's supersede reaper
// (mesh-host: supersededDeviceIds) recognizes every re-join as ONE device and forgets the stale writer
// keys — otherwise each re-join (which wipes the store → a fresh random WRITER key = a new `deviceId`)
// leaves a dead ghost in the grow-only membership CRDT (the "iPhone × 3" bug). Persisted as a SIBLING of
// storeDir so it survives `resetForJoin`'s wipe (which only removes the storeDir itself). Seeded once from
// the first writer key we ever hold; constant thereafter.
let deviceIdentity = "";
const identityPath = () => storeDir + ".identity";
function ensureIdentity() {
  if (deviceIdentity) return deviceIdentity;
  try {
    const v = b4a.toString(fs.readFileSync(identityPath())).trim();
    if (/^[0-9a-f]{64}$/i.test(v)) { deviceIdentity = v; return v; }
  } catch { /* none persisted yet */ }
  if (base?.local?.key) {
    deviceIdentity = b4a.toString(base.local.key, "hex");
    try { fs.writeFileSync(identityPath(), b4a.from(deviceIdentity)); } catch { /* best-effort */ }
  }
  return deviceIdentity;
}

/** A Hyperswarm wired to replicate the ROOT store on every connection (covers all namespaces). */
function makeSwarm() {
  const s = new Hyperswarm();
  s.on("connection", (conn) => {
    dbg("swarm: connection");
    try { conn.on("error", () => {}); store.replicate(conn); } catch (e) { dbg("replicate err " + (e?.message || String(e))); }
  });
  return s;
}

/** Stand the mesh up on an already-created `swarm` + `base`: join the topic, heartbeat, watch the view.
 *  The swarm must already exist (a fresh one for recovery, or the REUSED pairing swarm for a join — a
 *  joiner base needs a live connection to download the host's cores, so we never tear that down). */
async function goOnline() {
  // An autobase 'error' must be observed or it becomes an unhandled rejection → Bare abort.
  try { base.on("error", (e) => dbg("base ERROR " + (e?.message || String(e)))); } catch { /* ignore */ }
  dbg("goOnline: join discoveryKey");
  swarm.join(base.discoveryKey);
  dbg("goOnline: flush…");
  await swarm.flush().catch((e) => dbg("flush err " + (e?.message || String(e))));
  dbg("goOnline: advertise…");
  await advertise().catch((e) => dbg("advertise err " + (e?.message || String(e))));
  hbTimer = setInterval(() => {
    advertise().catch((e) => dbg("hb advertise err " + (e?.message || String(e))));
    reconnectWatchdog().catch((e) => dbg("hb watchdog err " + (e?.message || String(e))));
  }, 15_000);
  changeTimer = setInterval(() => { pollTasksChanged().catch((e) => dbg("poll err " + (e?.message || String(e)))); }, 1500);
  dbg("goOnline: done");
}

/** RECONNECT WATCHDOG (runs on the heartbeat tick): when we're a writable member but the swarm has
 *  dropped to ZERO connections (backgrounded → killed sockets, network flap), the phone is silently
 *  offline — advertises go nowhere and peers never see us. Re-join the swarm on the base discovery
 *  key, flush, and re-advertise to recover without a full teardown. Throttled to ≥30s between
 *  attempts so a genuinely-alone mesh (no peers up) doesn't churn the swarm every tick. */
async function reconnectWatchdog() {
  if (!base?.writable || !swarm) return;
  if (swarm.connections.size !== 0) return;
  const now = Date.now();
  if (now - lastReconnectAt < 30_000) return;
  lastReconnectAt = now;
  dbg("watchdog: 0 connections — re-joining swarm");
  swarm.join(base.discoveryKey);
  await swarm.flush().catch((e) => dbg("watchdog flush err " + (e?.message || String(e))));
  await advertise().catch((e) => dbg("watchdog advertise err " + (e?.message || String(e))));
  dbg("watchdog: re-join done, connections=" + swarm.connections.size);
}

/** Recover/found path: create a fresh swarm, then go online. */
async function bringOnline() {
  if (swarm) return;
  swarm = makeSwarm();
  await goOnline();
}

async function advertise() {
  if (!base?.writable) return;
  const cap = {
    deviceId: base.local ? b4a.toString(base.local.key, "hex") : "",
    consumerPublicKey: ensureIdentity(),           // STABLE across re-joins → supersede reaps stale writer keys
    meshId: base.key ? b4a.toString(base.key, "hex") : "", // groups this device's caps per-mesh for supersession
    displayName, computeClass: "phone", isProvider: false, joinedAt, lastSeen: new Date().toISOString(),
  };
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

/** Live (non-tombstoned) skills replicated from the desktop, for the phone's skill selector. */
async function readSkills() {
  await base.update();
  const out2 = [];
  for await (const { value } of base.view.createReadStream({ gte: "skill:", lt: "skill;" })) if (value && !value.deleted) out2.push(value);
  return out2;
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
  // A previously-paired root store recovers its writable base via the local core's referrer (no key) —
  // same as the desktop Primary mesh + the known-good build.
  // Exponential-backoff retry: a transient open failure on a cold start (fs not ready, store still
  // settling) must RETRY rather than give up and come up mesh-less — otherwise a reload/relaunch
  // silently drops the phone out of the mesh until a manual re-join. ~500ms ×1.5, cap 5s, ~30s budget.
  const t0 = Date.now();
  let delay = 500;
  for (let attempt = 1; ; attempt++) {
    try {
      base = new Autobase(store, null, { valueEncoding: "json", open: viewOpen, apply: viewApply });
      await base.ready();
      await bringOnline();
      dbg("openRecovered: ok attempt=" + attempt);
      return;
    } catch (e) {
      dbg("openRecovered: attempt " + attempt + " failed: " + (e?.message || String(e)));
      // Tear down the half-open base before retrying so we don't leak a dangling autobase/listener.
      if (base) { try { await base.close(); } catch { /* ignore */ } base = null; }
      if (Date.now() - t0 >= 30_000) { dbg("openRecovered: budget exhausted, giving up"); throw e; }
      await sleep(delay);
      delay = Math.min(Math.floor(delay * 1.5), 5_000);
    }
  }
}

/** Tear the current mesh down (close base + swarm + timers) and WIPE the store so a fresh join opens
 *  on an empty root store. The joiner's autobase MUST live in the root namespace (= the desktop host),
 *  so we can't isolate re-joins with a sub-namespace; instead, single-mesh phone → destroy the old
 *  store on a new join. (Wiping is acceptable: the phone holds one mesh at a time.) */
async function resetForJoin() {
  dbg("reset: clearing timers");
  if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
  if (changeTimer) { clearInterval(changeTimer); changeTimer = null; }
  if (swarm) { dbg("reset: destroying swarm"); try { await swarm.destroy(); } catch (e) { dbg("reset: swarm destroy err", String(e)); } swarm = null; }
  if (base) { dbg("reset: closing base"); try { await base.close(); } catch (e) { dbg("reset: base close err", String(e)); } base = null; }
  lastTaskSig = "";
  // Wipe + re-open a fresh root store. rmSync (NOT rmdirSync — bare-fs@4.7.1's rmdirSync takes no
  // options) with { recursive, force }. logPath is a sibling of storeDir, so the log survives.
  if (store) { dbg("reset: closing store"); try { await store.close(); } catch (e) { dbg("reset: store close err", String(e)); } store = null; }
  try { fs.rmSync(storeDir, { recursive: true, force: true }); } catch (e) { dbg("reset: rm err", String(e)); }
  store = new Corestore(storeDir, { allowBackup: true });
  await store.ready();
  dbg("reset: done, fresh root store");
}

async function pair(invite, label) {
  // Joining a mesh REPLACES any current one (single-mesh phone): wipe to a fresh root store first.
  await resetForJoin();
  meshLabel = (typeof label === "string" && label.trim()) ? label.trim() : "Private mesh";
  visibility = "private"; // blind-pairing == a private mesh
  // Blind-pairing candidate flow (mesh-graph.ts MeshGraph.pair, inlined). The invite is the capability;
  // the host promotes us to a writer (its add-writer entry replicates in shortly after).
  dbg("pair: new swarm");
  const pairSwarm = makeSwarm();
  const pairing = new BlindPairing(pairSwarm);
  dbg("pair: getLocalCore");
  const localCore = Autobase.getLocalCore(store);
  await localCore.ready();
  const userData = b4a.from(localCore.key);
  await localCore.close();
  dbg("pair: addCandidate, awaiting host confirm…");
  const candidate = pairing.addCandidate({ invite: b4a.from(invite, "hex"), userData, onadd: () => {} });
  const result = await candidate.pairing; // resolves when the host confirms (rejects on deny)
  dbg("pair: confirmed by host");
  await candidate.close();
  await pairing.close();
  // DO NOT destroy pairSwarm — REUSE it as the mesh swarm. A bootstrapped (joiner) base needs a live
  // connection to download the host's cores; tearing the swarm down here caused the base to throw
  // "Cannot read properties of null (reading 'download')" and the join silently died.
  dbg("pair: opening autobase on host key");
  base = new Autobase(store, result.key, { valueEncoding: "json", open: viewOpen, apply: viewApply });
  await base.ready();
  if (!joinedAt) joinedAt = Date.now();
  writeMeta({ joined: true, joinedAt, meshLabel, visibility });
  swarm = pairSwarm; // reuse the live pairing connection
  dbg("pair: goOnline");
  await goOnline();
  dbg("pair: waiting to become writable…");
  // Poll until the host's add-writer replicates and we become writable (bounded).
  const t0 = Date.now();
  while (!base.writable && Date.now() - t0 < 30_000) { await base.update().catch(() => {}); if (base.writable) break; await sleep(500); }
  dbg("pair: writable=" + base.writable);
  await advertise().catch((e) => dbg("final advertise err " + (e?.message || String(e))));
  dbg("pair: done");
}

// ── IPC dispatch ────────────────────────────────────────────────────────────────────────────────
async function handle(req) {
  const reply = (o) => out({ type: "reply", id: req.id, ok: true, ...o });
  try {
    switch (req.cmd) {
      case "init": {
        storeDir = req.storeDir;
        if (req.displayName) displayName = req.displayName;
        logPath = storeDir + ".worklet.log";
        try { fs.writeFileSync(logPath, "=== worklet init ===\n"); } catch { /* fs not ready */ }
        dbg("init: storeDir=" + storeDir);
        store = new Corestore(storeDir, { allowBackup: true });
        await store.ready();
        const meta = readMeta();
        joinedAt = typeof meta.joinedAt === "number" ? meta.joinedAt : 0;
        if (typeof meta.meshLabel === "string" && meta.meshLabel) meshLabel = meta.meshLabel;
        if (meta.visibility === "public" || meta.visibility === "private") visibility = meta.visibility;
        dbg("init: meta.joined=" + !!meta.joined);
        if (meta.joined) await openRecovered(); // mesh-less until the first join otherwise
        dbg("init: done joined=" + !!base);
        return reply({ joined: !!base });
      }
      case "join": {
        dbg("join: cmd received");
        if (!store) throw new Error("call init before join");
        if (!req.invite) throw new Error("an invite is required");
        await pair(req.invite, req.label);
        return reply({ joined: true, writable: !!base?.writable });
      }
      case "leave": {
        // Drop this phone's membership: tear the mesh down + wipe the store, then mark not-joined so a
        // relaunch comes up mesh-less. The desktop mesh lives on for its other members.
        dbg("leave: cmd received");
        await resetForJoin(); // closes base+swarm+timers, wipes + re-opens an empty root store
        base = null;          // resetForJoin already nulls it, but be explicit: we are NOT re-joining
        meshLabel = "Private mesh";
        visibility = "private";
        joinedAt = 0;
        lastTaskSig = "";
        writeMeta({ joined: false });
        dbg("leave: done");
        return reply({ joined: false });
      }
      case "tasks.list":
        // Returns tombstones too (the RN side LWW-merges them into its local cache).
        return reply({ tasks: base ? await readAllTasks() : [] });
      case "skills.list":
        // Skills replicated from the desktop (Stage 4) — the phone's skill selector reads these.
        return reply({ skills: base ? await readSkills() : [] });
      case "skills.upsert": {
        // Desktop publisher path (also usable from the phone): append a skill record to the CRDT.
        if (!base) throw new Error("not in a mesh yet — scan an invite first");
        if (!base.writable) throw new Error("mesh not writable yet (still syncing)");
        const s = req.skill || {};
        const skill = { slug: s.slug, name: s.name ?? s.slug, description: s.description ?? "", body: s.body ?? "", examples: s.examples ?? [], whenToUse: s.whenToUse ?? "", updatedAt: s.updatedAt ?? Date.now() };
        await base.append({ type: "skill", skill });
        return reply({ skill });
      }
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
        const leaderId = base ? await leader() : null;
        // Resolve the leader's advertised name + shared mesh label from the replicated cap roster, so the
        // UI shows a real peer name (not "a peer") and the LEADER/creator's mesh name wins over our local
        // label (every member then agrees on one shared name — BUG 3).
        let leaderName;
        let sharedLabel = meshLabel;
        if (base && leaderId) {
          const leaderCap = (await readCaps().catch(() => [])).find((c) => c.deviceId === leaderId);
          leaderName = leaderCap?.displayName;
          sharedLabel = leaderCap?.meshLabel ?? meshLabel;
        }
        return reply({ joined: !!base, writable: !!base?.writable, peers: swarm ? swarm.connections.size : 0, leader: leaderId, leaderName, deviceId, meshLabel: sharedLabel, visibility });
      }
      case "peers.list": {
        // The mesh's advertised members (capabilities), newest-seen first — for the expandable peer list.
        if (!base) return reply({ peers: [] });
        const caps = await readCaps().catch(() => []);
        caps.sort((a, b) => (Date.parse(b.lastSeen || "") || 0) - (Date.parse(a.lastSeen || "") || 0));
        return reply({ peers: caps });
      }
      case "reconnect": {
        // Forced immediate reconnect (RN calls this when the app returns to the foreground): tear the
        // swarm + timers down and bring the mesh back online — re-creates the swarm, re-joins the base
        // discovery key, and re-advertises. The base (and its store) survive, so it's much cheaper than
        // a re-join/leave. No-op error if we were never in a mesh.
        dbg("reconnect: cmd received");
        if (!base) throw new Error("not in a mesh yet");
        if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
        if (changeTimer) { clearInterval(changeTimer); changeTimer = null; }
        if (swarm) { dbg("reconnect: destroying swarm"); try { await swarm.destroy(); } catch (e) { dbg("reconnect: swarm destroy err", String(e)); } swarm = null; }
        lastReconnectAt = Date.now();
        await bringOnline(); // re-creates swarm + re-joins + re-advertises + restarts timers
        dbg("reconnect: done writable=" + !!base?.writable);
        return reply({ joined: !!base, writable: !!base?.writable });
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
