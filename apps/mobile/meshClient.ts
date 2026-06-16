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

export type MeshStatus = { joined: boolean; writable: boolean; peers: number; leader: string | null; deviceId: string | null; meshLabel?: string; visibility?: "private" | "public" };

/** One advertised mesh member (from the worklet's capability records). */
export type MeshPeer = { deviceId: string; displayName: string; computeClass: string; isProvider: boolean; joinedAt: number; lastSeen: string };

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

export async function meshStatus(): Promise<MeshStatus> {
  await initMesh();
  return (await call("status")) as MeshStatus;
}

/** Subscribe to remote task changes (a peer edited/deleted a task and it replicated in). */
export function onTasksChanged(cb: () => void): () => void {
  changeListeners.add(cb);
  return () => changeListeners.delete(cb);
}
