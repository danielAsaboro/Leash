/**
 * React Native bridge to the mesh Bare worklet (worklets/mesh-worklet.mjs → mesh-worklet.bundle.js).
 * Runs a real Corestore + Autobase + Hyperbee + Hyperswarm + blind-pairing inside react-native-bare-kit,
 * so the phone is a true private-mesh member replicating the task CRDT — not a delegated-inference client.
 *
 * Mirrors forwardWorklet.ts: a single lazily-started worklet, newline-JSON over BareKit.IPC, with each
 * command promise-wrapped by request id. `onTasksChanged` fires when a peer's edit replicates in.
 */
import * as FileSystem from "expo-file-system/legacy";
import * as Device from "expo-device";

export type MeshTask = {
  id: string;
  title: string;
  detail?: string;
  status: "open" | "in_progress" | "done" | "dropped";
  priority: "low" | "normal" | "high";
  tags: string[];
  source: string;
  createdAt: number;
  updatedAt: number;
  deleted?: boolean;
};

export type MeshStatus = { joined: boolean; writable: boolean; peers: number; leader: string | null; leaderName?: string; deviceId: string | null; meshLabel?: string; visibility?: "private" | "public" };

/** A model a provider advertises into the mesh (alias + the delegable source). */
export type MeshModel = { alias: string; modelSrc: string; modelType?: string; borrowable?: boolean; projectionModelSrc?: string };

/** One advertised mesh member (the worklet returns the FULL capability record; provider
 *  members also carry providerPublicKey + the models they serve, so a consumer can borrow
 *  compute from them automatically — no hardcoded key). */
export type MeshPeer = {
  deviceId: string;
  displayName: string;
  computeClass: string;
  isProvider: boolean;
  joinedAt: number;
  lastSeen: string;
  providerPublicKey?: string;
  consumerPublicKey?: string;
  meshId?: string;
  models?: MeshModel[];
  availableModels?: string[];
  inflight?: number;
};

/**
 * Collapse ghost duplicates the same way web/desktop do (packages/mesh `supersededDeviceIds`): a
 * device's `deviceId` is its mesh WRITER key, which changes on every re-join/reinstall, but its
 * `consumerPublicKey`/`providerPublicKey` (stable identity) does not. So for each (stable identity,
 * mesh) keep only the most-recently-seen writer key — every physical device shows up ONCE. Peers
 * without a stable identity are passed through untouched.
 *
 * CORRECT BY DESIGN: this collapses same-identity GHOSTS (a re-join that minted a fresh writer key
 * under the SAME stable identity). A device that fully wiped + REGENERATED its stable identity is a
 * legitimately different identity and survives as its OWN row — that's not a dup, it's a genuinely
 * distinct (reset) device. Do not "fix" that by collapsing on displayName; it would hide real peers.
 */
export function dedupePeers(peers: MeshPeer[]): MeshPeer[] {
  const newestByIdentity = new Map<string, MeshPeer>();
  const passthrough: MeshPeer[] = [];
  for (const p of peers) {
    const identity = p.consumerPublicKey || p.providerPublicKey;
    if (!identity) { passthrough.push(p); continue; }
    const key = `${identity}::${p.meshId ?? ""}`;
    const cur = newestByIdentity.get(key);
    if (!cur || Date.parse(p.lastSeen || "") > Date.parse(cur.lastSeen || "")) newestByIdentity.set(key, p);
  }
  return [...newestByIdentity.values(), ...passthrough];
}

/** A resolved auto-offload target: which peer to borrow chat compute from, and the model to run.
 *  `alias` is the provider's serve model id (what the forward body's `model` field must be). */
export type ChatOffloadTarget = { providerPublicKey: string; modelSrc: string; alias: string; displayName: string; deviceId: string };

/**
 * Pick a live provider in the mesh to borrow CHAT compute from — the automatic "borrow a brain".
 * Mirrors the desktop warm-pool's selection (live + borrowable + lowest inflight), purely from the
 * replicated capability roster. Returns null when no provider is advertising a borrowable chat model
 * (→ chat runs on-device). No hardcoded keys or model ids.
 */
export async function pickChatProvider(staleMs = 45_000): Promise<ChatOffloadTarget | null> {
  const peers = await peersList().catch(() => [] as MeshPeer[]);
  const now = Date.now();
  // Diagnostic: how many provider peers the phone currently holds (terse).
  console.log("[autoborrow] provider peers:", peers.filter((p) => p.isProvider).length);
  let best: ChatOffloadTarget | null = null;
  let bestInflight = Infinity;
  for (const p of peers) {
    if (!p.isProvider || !p.providerPublicKey) continue;
    if (now - (Date.parse(p.lastSeen || "") || 0) > staleMs) continue;
    const chat = (p.models ?? []).find(
      (m) => m.borrowable !== false && !!m.modelSrc && (m.alias === "chat" || m.modelType === "chat"),
    );
    if (!chat) continue;
    const inflight = p.inflight ?? 0;
    if (inflight < bestInflight) {
      bestInflight = inflight;
      best = { providerPublicKey: p.providerPublicKey, modelSrc: chat.modelSrc, alias: chat.alias, displayName: p.displayName, deviceId: p.deviceId };
    }
  }
  return best;
}

/**
 * This phone's STABLE mesh identity (`consumerPublicKey`) — the key the provider's forward server
 * allow-lists and the consumer half of the per-pair forward topic. Derived from the roster: the self
 * cap is the one whose writer `deviceId` matches `status.deviceId`. Returns "" if not yet known.
 */
export async function selfConsumerKey(): Promise<string> {
  try {
    const status = await meshStatus();
    if (!status.deviceId) return "";
    const peers = await peersList();
    const self = peers.find((p) => p.deviceId === status.deviceId);
    return self?.consumerPublicKey ?? "";
  } catch {
    return "";
  }
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

let worklet: any = null;
let ipc: any = null;
let started = false;
let initPromise: Promise<void> | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
const changeListeners = new Set<() => void>();
let readyResolve: (() => void) | null = null;
const readyPromise = new Promise<void>((r) => { readyResolve = r; });

function decode(chunk: any): string {
  if (typeof chunk === "string") return chunk;
  try { return new TextDecoder().decode(chunk); } catch {
    let s = ""; const a = chunk as Uint8Array;
    for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]!);
    try { return decodeURIComponent(escape(s)); } catch { return s; }
  }
}
function encode(str: string): Uint8Array {
  try { return new TextEncoder().encode(str); } catch {
    const a = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) a[i] = str.charCodeAt(i) & 0xff;
    return a;
  }
}

function handleFrame(f: any) {
  if (f?.type === "ready") { readyResolve?.(); return; }
  if (f?.type === "event" && f.ev === "tasks.changed") { for (const cb of changeListeners) { try { cb(); } catch { /* ignore */ } } return; }
  if (typeof f?.id !== "number") return;
  const p = pending.get(f.id);
  if (!p) return;
  pending.delete(f.id);
  if (f.type === "error") p.reject(new Error(f.error || "mesh worklet error"));
  else p.resolve(f);
}

function ensureStarted() {
  if (started) return;
  started = true;
  // Lazy: neither the ~2 MB bundle string nor react-native-bare-kit touch app startup.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const MESH_BUNDLE: string = require("./worklets/mesh-worklet.bundle.js");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Worklet } = require("react-native-bare-kit");
  worklet = new Worklet();
  worklet.start("/mesh.bundle", MESH_BUNDLE, []);
  ipc = worklet.IPC;
  let buf = "";
  ipc.on("data", (chunk: any) => {
    buf += decode(chunk);
    const parts = buf.split("\n");
    buf = parts.pop() || "";
    for (const line of parts) {
      if (!line) continue;
      let f: any;
      try { f = JSON.parse(line); } catch { continue; }
      handleFrame(f);
    }
  });
}

/** Send a command and await its reply (by id). Worklet errors reject the promise. */
function call(cmd: string, extra: Record<string, unknown> = {}, timeoutMs = 45_000): Promise<any> {
  ensureStarted();
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { if (pending.delete(id)) reject(new Error(`mesh "${cmd}" timed out`)); }, timeoutMs);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    const send = () => ipc.write(encode(JSON.stringify({ id, cmd, ...extra }) + "\n"));
    readyPromise.then(send, send);
  });
}

/** Open/recover the phone's mesh store. Idempotent — safe to call on every app launch. */
export function initMesh(): Promise<void> {
  if (initPromise) return initPromise;
  const storeDir = (FileSystem.documentDirectory ?? "").replace(/^file:\/\//, "") + "mesh-store";
  const displayName = Device.deviceName || Device.modelName || "iPhone";
  initPromise = call("init", { storeDir, displayName }).then(() => undefined);
  return initPromise;
}

/** Blind-pair into a desktop's mesh using its hex invite (minted by hypha /mesh/invite). */
export async function joinMesh(invite: string, label?: string): Promise<void> {
  await initMesh();
  await call("join", { invite: invite.trim(), ...(label ? { label } : {}) }, 60_000);
}

/** Leave the current mesh — drops this phone's membership and wipes its local store. */
export async function leaveMesh(): Promise<void> {
  await initMesh();
  await call("leave", {}, 30_000);
}

/** The mesh's advertised members (for the expandable peer list). Empty when not joined. */
export async function peersList(): Promise<MeshPeer[]> {
  await initMesh();
  return (await call("peers.list")).peers as MeshPeer[];
}

export async function listTasks(): Promise<MeshTask[]> {
  await initMesh();
  return (await call("tasks.list")).tasks as MeshTask[];
}

export async function upsertTask(task: Partial<MeshTask> & { id: string }): Promise<MeshTask> {
  await initMesh();
  return (await call("tasks.upsert", { task })).task as MeshTask;
}

export async function deleteTask(id: string, ts: number = Date.now()): Promise<void> {
  await initMesh();
  await call("tasks.delete", { id, ts });
}

/** A skill replicated over the mesh CRDT (published by the desktop; consumed by the phone selector). */
export type MeshSkill = { slug: string; name: string; description: string; body: string; examples?: string[]; whenToUse?: string; updatedAt?: number };

/** Skills the desktop has published into the mesh (Stage 4). Empty when not joined / none published. */
export async function listMeshSkills(): Promise<MeshSkill[]> {
  await initMesh();
  return ((await call("skills.list")).skills ?? []) as MeshSkill[];
}

/** Publish a skill into the mesh CRDT (the desktop publisher path; also callable from the phone). */
export async function upsertMeshSkill(skill: MeshSkill): Promise<MeshSkill> {
  await initMesh();
  return (await call("skills.upsert", { skill: { ...skill, updatedAt: skill.updatedAt ?? Date.now() } })).skill as MeshSkill;
}

export async function meshStatus(): Promise<MeshStatus> {
  await initMesh();
  return (await call("status")) as MeshStatus;
}

/**
 * Force an immediate mesh reconnect — re-creates the worklet's swarm, re-joins the base discovery
 * key, and re-advertises. App.tsx calls this from an AppState listener when the app returns to the
 * foreground (backgrounding kills the P2P sockets, so the phone silently goes offline otherwise).
 * No-op-rejects if not in a mesh yet. ~30s timeout (swarm.flush can be slow on a cold network).
 */
export async function reconnect(): Promise<{ joined: boolean; writable: boolean }> {
  await initMesh();
  return (await call("reconnect", {}, 30_000)) as { joined: boolean; writable: boolean };
}

/** Subscribe to remote task changes (a peer edited/deleted a task and it replicated in). */
export function onTasksChanged(cb: () => void): () => void {
  changeListeners.add(cb);
  return () => changeListeners.delete(cb);
}
