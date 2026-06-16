/**
 * `/api/leash/hypha/share` — the mesh model-sharing surface.
 *   GET  → this node's share state + the peers it sees (with the models each shares) + the local
 *          alias→registry-name map (config is synced mesh-wide, so a peer's alias resolves locally,
 *          which is how a "Pull" reuses the existing P2P download by registry name).
 *   POST → flip this node's `shareModels` toggle (advisory; peers stop being offered this node's models).
 * Never silent-catch: a down daemon surfaces an honest error the card shows.
 */
import { modelsInventory } from "../../../../../lib/leash/models.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PORT = Number(process.env["HYPHA_PORT"] ?? 11437);
const BASE = `http://127.0.0.1:${PORT}`;

interface SharePeer {
  deviceId: string;
  displayName: string;
  live: boolean;
  shareModels: boolean;
  models: string[];
  /** Per-model modality + borrowable tag (SP2) — drives the chip's modality label + "local-only". */
  modelInfo: { alias: string; modelType: string; borrowable: boolean }[];
  warmModels: string[];
  /** Node classification — surfaced in the per-mesh peer detail (Settings → Devices → My meshes). */
  computeClass: string;
  ramMB: number;
  powerState: string;
  inflight: number;
  lastSeen: string;
  /** Which mesh this peer belongs to — lets the UI group peers under each mesh. */
  meshId?: string;
  meshLabel?: string;
}

interface RawPeer {
  deviceId?: string;
  displayName?: string;
  live?: boolean;
  shareModels?: boolean;
  models?: string[];
  modelInfo?: { alias: string; modelType: string; borrowable: boolean }[];
  warmModels?: string[];
  computeClass?: string;
  ramMB?: number;
  powerState?: string;
  inflight?: number;
  lastSeen?: string;
  meshId?: string;
  meshLabel?: string;
}

/** A mesh member (CRDT capability) — the TRUE membership incl. this device + non-provider phones. */
interface MeshMember {
  deviceId: string;
  displayName: string;
  computeClass: string;
  ramMB: number;
  powerState: string;
  inflight: number;
  lastSeen: string;
  models: string[];
  meshId: string;
  meshLabel: string;
  live: boolean;
  self: boolean;
}

export async function GET(): Promise<Response> {
  try {
    const [peersRes, shareRes, membersRes] = await Promise.all([
      fetch(`${BASE}/peers`, { signal: AbortSignal.timeout(2500), cache: "no-store" }),
      fetch(`${BASE}/models/share`, { signal: AbortSignal.timeout(2500), cache: "no-store" }),
      fetch(`${BASE}/mesh/members`, { signal: AbortSignal.timeout(2500), cache: "no-store" }).catch(() => null),
    ]);
    const peersBody = (await peersRes.json()) as { peers?: RawPeer[] };
    const shareBody = (await shareRes.json()) as { shareModels?: boolean; unshared?: string[] };
    const members: MeshMember[] = membersRes && membersRes.ok ? ((await membersRes.json()) as { members?: MeshMember[] }).members ?? [] : [];
    const peers: SharePeer[] = (peersBody.peers ?? []).map((p) => ({
      deviceId: p.deviceId ?? "",
      displayName: p.displayName ?? "peer",
      live: Boolean(p.live),
      shareModels: p.shareModels !== false,
      models: p.models ?? [],
      modelInfo: p.modelInfo ?? (p.models ?? []).map((alias) => ({ alias, modelType: "chat", borrowable: true })),
      warmModels: p.warmModels ?? [],
      computeClass: p.computeClass ?? "—",
      ramMB: p.ramMB ?? 0,
      powerState: p.powerState ?? "—",
      inflight: p.inflight ?? 0,
      lastSeen: p.lastSeen ?? "",
      meshId: p.meshId,
      meshLabel: p.meshLabel,
    }));
    // alias → SDK registry name, from this node's (mesh-synced) config inventory, for the Pull action.
    let aliasToName: Record<string, string> = {};
    let myModels: string[] = [];
    try {
      const inv = await modelsInventory();
      aliasToName = Object.fromEntries(inv.configured.filter((r) => r.alias).map((r) => [r.alias as string, r.name]));
      myModels = inv.configured.filter((r) => r.onDiskBytes != null && r.alias).map((r) => r.alias as string);
    } catch {
      /* inventory is best-effort context for the Pull affordance */
    }
    return Response.json({ ok: true, shareModels: shareBody.shareModels !== false, unshared: shareBody.unshared ?? [], peers, members, aliasToName, myModels });
  } catch {
    return Response.json({ ok: false, error: "Hypha daemon not running — start it on the Services page." }, { status: 503 });
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { on?: boolean; alias?: string };
    const payload = typeof body.alias === "string" ? { alias: body.alias, on: Boolean(body.on) } : { on: Boolean(body.on) };
    const r = await fetch(`${BASE}/models/share`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(4000),
      cache: "no-store",
    });
    return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
  } catch {
    return Response.json({ ok: false, error: "Couldn't reach the Hypha daemon to change sharing." }, { status: 503 });
  }
}
