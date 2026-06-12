/**
 * MeshEventBus — an in-memory, browser-subscribable mirror of the delegation routing
 * events the shim already writes to the JSONL audit. The audit log is the source of
 * truth (durable, evidence-grade); this is the LIVE pub/sub a dashboard SSE can ride so
 * the mesh visualization lights up as routes fire — without opening the audit file or a
 * corestore from the web process.
 *
 * Hot-path discipline: `record()` NEVER throws (a delegation decode must not be disturbed
 * by the event mirror) and a bounded ring buffer lets a late subscriber replay recent
 * activity (demo-robustness: the viz shows context the instant it connects).
 */
import { EventEmitter } from "node:events";

/** One routing event. `kind` is the coarse class the viz switches on; `phase` keeps the
 *  exact shim phase for detail/debugging. `peer` is the truncated provider key (the node
 *  to light up). */
export interface MeshEvent {
  ts: number;
  kind: "route" | "done" | "failed";
  phase: string;
  alias?: string;
  peer?: string;
  peers?: number;
  endpoint?: string;
  meshId?: string;
  tokens?: number;
  bytes?: number;
  ms?: number;
  error?: string;
}

/** How many recent events to retain for replay on connect. */
const RING = 200;
/** SSE event name subscribers listen on. */
export const MESH_EVENT = "mesh";

class MeshEventBus extends EventEmitter {
  private ring: MeshEvent[] = [];

  constructor() {
    super();
    this.setMaxListeners(0); // many dashboards/SSE clients may subscribe; no leak warning
  }

  /** Stamp, ring-buffer, and fan out one event. Best-effort: swallows any failure so the
   *  delegation hot path is never disturbed. */
  record(e: Omit<MeshEvent, "ts">): void {
    try {
      const evt: MeshEvent = { ts: Date.now(), ...e };
      this.ring.push(evt);
      if (this.ring.length > RING) this.ring.shift();
      this.emit(MESH_EVENT, evt);
    } catch {
      /* event mirror is best-effort — never throw into a delegation decode */
    }
  }

  /** Recent events, oldest→newest, for replay when a subscriber connects. */
  recent(): MeshEvent[] {
    return this.ring.slice();
  }
}

/** Process-wide singleton — the shim records into it; the `/events` SSE route subscribes. */
export const meshBus = new MeshEventBus();
