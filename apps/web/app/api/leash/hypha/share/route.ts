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
  displayName: string;
  live: boolean;
  shareModels: boolean;
  models: string[];
}

export async function GET(): Promise<Response> {
  try {
    const [peersRes, shareRes] = await Promise.all([
      fetch(`${BASE}/peers`, { signal: AbortSignal.timeout(2500), cache: "no-store" }),
      fetch(`${BASE}/models/share`, { signal: AbortSignal.timeout(2500), cache: "no-store" }),
    ]);
    const peersBody = (await peersRes.json()) as { peers?: Array<{ displayName?: string; live?: boolean; shareModels?: boolean; models?: string[] }> };
    const shareBody = (await shareRes.json()) as { shareModels?: boolean; unshared?: string[] };
    const peers: SharePeer[] = (peersBody.peers ?? []).map((p) => ({
      displayName: p.displayName ?? "peer",
      live: Boolean(p.live),
      shareModels: p.shareModels !== false,
      models: p.models ?? [],
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
    return Response.json({ ok: true, shareModels: shareBody.shareModels !== false, unshared: shareBody.unshared ?? [], peers, aliasToName, myModels });
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
