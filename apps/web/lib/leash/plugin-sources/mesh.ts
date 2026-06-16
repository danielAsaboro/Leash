/**
 * Mesh plugin source (server-only) — stage a plugin replicated over the device mesh.
 *
 * On-brand distribution: a plugin bundle rides the SAME Hypercore-blob replication that ships LoRA
 * adapters today (mesh-graph.ts). The hypha daemon owns the P2P + sha256 verify; the web side just
 * talks to its localhost shim (exactly as `mesh.server.ts` calls `/peers`):
 *   · `GET  /plugins/catalog`        — the per-id catalog of published plugins (offline-browsable)
 *   · `POST /plugins/fetch {pluginId}` — fetch + verify the bundle, returns the zip bytes
 *   · `POST /plugins/publish {pluginId}` — publish a locally-installed plugin to the mesh
 */
import "server-only";
import { stageFromUploadZip } from "./upload.ts";
import type { StagedPlugin } from "./stage.ts";

const HYPHA_PORT = Number(process.env["HYPHA_PORT"] ?? 11437);
const BASE = `http://127.0.0.1:${HYPHA_PORT}`;

/** One published plugin's catalog metadata (mirrors the hypha-side `plugin` autobase record). */
export interface MeshPluginMeta {
  pluginId: string;
  name: string;
  version?: string;
  description?: string;
  sha256: string;
  size: number;
}

function down(): Error {
  return new Error("Hypha daemon not running — start it on the Services page to use mesh plugins.");
}

/** The mesh's published-plugin catalog (offline-first once warmed). */
export async function fetchMeshCatalog(): Promise<MeshPluginMeta[]> {
  let r: Response;
  try {
    r = await fetch(`${BASE}/plugins/catalog`, { signal: AbortSignal.timeout(4000), cache: "no-store" });
  } catch {
    throw down();
  }
  if (!r.ok) throw new Error(`Hypha answered ${r.status} for the plugin catalog`);
  const j = (await r.json()) as { plugins?: MeshPluginMeta[] };
  return j.plugins ?? [];
}

/** Fetch + verify a published bundle and stage it (the daemon verifies sha256/size before returning). */
export async function stageFromMesh(pluginId: string): Promise<StagedPlugin> {
  const id = pluginId.trim();
  if (!id) throw new Error("a pluginId is required");
  let r: Response;
  try {
    r = await fetch(`${BASE}/plugins/fetch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pluginId: id }),
      signal: AbortSignal.timeout(120_000),
      cache: "no-store",
    });
  } catch {
    throw down();
  }
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(msg || `Hypha answered ${r.status} fetching plugin "${id}"`);
  }
  const bytes = new Uint8Array(await r.arrayBuffer());
  return stageFromUploadZip(bytes);
}

/** Publish a locally-installed plugin to the mesh (the daemon zips its tree + announces the catalog row). */
export async function publishToMesh(pluginId: string): Promise<MeshPluginMeta> {
  const id = pluginId.trim();
  if (!id) throw new Error("a pluginId is required");
  let r: Response;
  try {
    r = await fetch(`${BASE}/plugins/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pluginId: id }),
      signal: AbortSignal.timeout(120_000),
      cache: "no-store",
    });
  } catch {
    throw down();
  }
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(msg || `Hypha answered ${r.status} publishing plugin "${id}"`);
  }
  return (await r.json()) as MeshPluginMeta;
}
