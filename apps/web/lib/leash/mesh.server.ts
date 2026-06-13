/**
 * Mesh membership (server-only) for the `/mesh` monitor routes. Reads the daemon's `GET /peers`
 * (which carries `meshes` — this device's memberships, private + public) so the per-mesh page can
 * decide access server-side: a mesh this device belongs to renders; an unknown / non-member
 * private id is forbidden. Best-effort — a down daemon is surfaced, never silent-catch.
 */
import "server-only";
import type { MeshSummary } from "../../components/mesh/types.ts";

const HYPHA_PORT = Number(process.env["HYPHA_PORT"] ?? 11437);
const BASE = `http://127.0.0.1:${HYPHA_PORT}`;

export interface MeshListResult {
  /** false only when the daemon is unreachable — membership cannot be verified. */
  reachable: boolean;
  error?: string;
  meshes: MeshSummary[];
}

export async function meshList(): Promise<MeshListResult> {
  try {
    const r = await fetch(`${BASE}/peers`, { signal: AbortSignal.timeout(2500), cache: "no-store" });
    if (!r.ok) return { reachable: false, error: `Hypha daemon answered ${r.status}.`, meshes: [] };
    const j = (await r.json()) as { meshes?: MeshSummary[] };
    return { reachable: true, meshes: j.meshes ?? [] };
  } catch {
    return { reachable: false, error: "Hypha daemon not running — start it on the Services page.", meshes: [] };
  }
}

/** Access verdict for `/mesh/<meshId>`. */
export type MeshAccess =
  | { kind: "ok"; mesh: MeshSummary }
  | { kind: "forbidden"; meshId: string } // known/likely private, not a member
  | { kind: "unverifiable"; meshId: string }; // daemon down — let the canvas show its offline state

export async function resolveMeshAccess(meshId: string): Promise<MeshAccess> {
  const { reachable, meshes } = await meshList();
  if (!reachable) return { kind: "unverifiable", meshId };
  const mesh = meshes.find((m) => m.meshId === meshId);
  // Member of it (private or public) → render. Otherwise it's not on this device: forbidden.
  // (A public mesh this device joined is already a membership; an unknown id we can't vouch for.)
  if (mesh) return { kind: "ok", mesh };
  return { kind: "forbidden", meshId };
}
