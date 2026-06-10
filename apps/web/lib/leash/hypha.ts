/**
 * Hypha mesh status (server-only) for the Services card.
 *
 * Reads the daemon's `GET /peers` (paired peers + link warmth) and the broker's overflow
 * counters (`/__broker/stats`). Both are best-effort: if a daemon is down we surface that
 * honestly (an `error` string the card shows) rather than silent-catching to an empty UI.
 */
import "server-only";

const HYPHA_PORT = Number(process.env["HYPHA_PORT"] ?? 11437);
const BROKER_PORT = Number(process.env["LEASH_BROKER_PORT"] ?? 11436);

export interface MeshPeer {
  deviceId: string;
  displayName: string;
  computeClass: string;
  ramMB: number;
  powerState: string;
  inflight: number;
  models: string[];
  warmModels: string[];
  live: boolean;
  warm: boolean;
  lastSeen: string;
  /** Which mesh this peer belongs to (multi-mesh) — absent on a pre-multi-mesh daemon. */
  meshId?: string;
  meshLabel?: string;
}

/** One membership this device holds (spec §3) — for the memberships list + per-mesh actions. */
export interface MeshMembership {
  meshId: string;
  label: string;
  visibility: string;
  tier: number;
  peers: number;
  writable: boolean;
}

export interface BorrowCounters {
  shed: number;
  availabilityRouted: number;
  overflowFailures: number;
}

export interface MeshStatus {
  peers: MeshPeer[];
  borrow: BorrowCounters | null;
  /** Whether the PRIMARY mesh can write (null = mesh offline / daemon down). */
  writable: boolean | null;
  /** Short PRIMARY mesh id (autobase key prefix) — same on every member of that mesh. */
  meshId: string | null;
  /** Device keys this device has disconnected (local tombstones) — restorable. */
  forgotten: string[];
  /** Every mesh this device belongs to (spec §3). Empty on a pre-multi-mesh daemon. */
  meshes: MeshMembership[];
  /** Null when the daemon answered; a message when it didn't (shown on the card). */
  error: string | null;
}

export async function meshStatus(): Promise<MeshStatus> {
  let peers: MeshPeer[] = [];
  let writable: boolean | null = null;
  let meshId: string | null = null;
  let forgotten: string[] = [];
  let meshes: MeshMembership[] = [];
  let error: string | null = null;
  try {
    const r = await fetch(`http://127.0.0.1:${HYPHA_PORT}/peers`, { signal: AbortSignal.timeout(1500), cache: "no-store" });
    if (!r.ok) error = `Hypha shim answered ${r.status}`;
    else {
      const body = (await r.json()) as { peers?: MeshPeer[]; writable?: boolean | null; meshId?: string | null; forgotten?: string[]; meshes?: MeshMembership[] };
      peers = body.peers ?? [];
      writable = body.writable ?? null;
      meshId = body.meshId ?? null;
      forgotten = body.forgotten ?? [];
      meshes = body.meshes ?? [];
    }
  } catch {
    error = "Hypha daemon not running — start it to pair peers and serve delegated overflow.";
  }

  let borrow: BorrowCounters | null = null;
  try {
    const r = await fetch(`http://127.0.0.1:${BROKER_PORT}/__broker/stats`, { signal: AbortSignal.timeout(1500), cache: "no-store" });
    if (r.ok) {
      const o = ((await r.json()) as { overflow?: BorrowCounters }).overflow;
      if (o) borrow = { shed: o.shed ?? 0, availabilityRouted: o.availabilityRouted ?? 0, overflowFailures: o.overflowFailures ?? 0 };
    }
  } catch {
    /* broker counters are optional context; the peers list above is the primary signal */
  }

  return { peers, borrow, writable, meshId, forgotten, meshes, error };
}
