/**
 * Layer-4 adapter distribution over the LIVE mesh — hub-resident, opt-in.
 *
 * The mesh corestore is single-process: the hub already owns it + the Hyperswarm and
 * stays alive, so adapter publish/fetch MUST run inside this process (a standalone
 * script would collide on the store). This is a symmetric, idempotent pass run by
 * every hub in the mesh:
 *   · PUBLISH — the newest local promotable adapter (evalDelta>=0) the mesh doesn't
 *     already carry → chunked onto the sibling Hypercore, a tiny pointer on the CRDT.
 *   · FETCH   — any mesh adapter newer than what's on local disk → reassembled,
 *     sha256-verified, written to data/adapters/<version>/.
 *
 * Whoever trained tonight publishes; every other device pulls. Cheap (acts only on a
 * change); enabled with MYCELIUM_ADAPTER_SYNC=1.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AuditLog } from "@mycelium/shared";
import type { MeshGraph } from "@mycelium/mesh";
import { REPO_ROOT } from "./config.ts";

const DEFAULT_ADAPTERS_DIR = join(REPO_ROOT, "data", "adapters");

interface LocalManifest {
  version: string;
  baseModel: string;
  evalDelta: number;
}

/** Newest local adapter dir with a manifest.json (evalDelta>=0) AND an adapter.gguf, or null. */
function newestLocalPromotable(adaptersDir: string): { version: string; ggufPath: string; manifestPath: string; manifest: LocalManifest } | null {
  if (!existsSync(adaptersDir)) return null;
  for (const version of readdirSync(adaptersDir).sort().reverse()) {
    const ggufPath = join(adaptersDir, version, "adapter.gguf");
    const manifestPath = join(adaptersDir, version, "manifest.json");
    if (!existsSync(ggufPath) || !existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as LocalManifest;
      if (typeof manifest.evalDelta === "number" && manifest.evalDelta >= 0) return { version, ggufPath, manifestPath, manifest };
    } catch {
      /* skip a corrupt manifest */
    }
  }
  return null;
}

const haveLocally = (adaptersDir: string, version: string): boolean => existsSync(join(adaptersDir, version, "adapter.gguf"));

export interface SyncOnceOptions {
  audit?: AuditLog;
  /** Override the adapters dir (tests). Defaults to <repo>/data/adapters. */
  adaptersDir?: string;
  /** Versions already published this session (mutated). Pass to avoid re-publishing across passes. */
  publishedThisSession?: Set<string>;
  /** Emit progress lines (the daemon does; tests stay quiet). */
  log?: boolean;
}

export interface SyncResult {
  published?: string;
  fetched?: string;
}

/** One publish+fetch pass. Returns what (if anything) crossed the mesh this pass. */
export async function syncAdaptersOnce(graph: MeshGraph, opts: SyncOnceOptions = {}): Promise<SyncResult> {
  const adaptersDir = opts.adaptersDir ?? DEFAULT_ADAPTERS_DIR;
  const published = opts.publishedThisSession ?? new Set<string>();
  const log = (m: string) => { if (opts.log) console.log(m); };
  const result: SyncResult = {};

  // 1. PUBLISH the newest local promotable adapter the mesh doesn't already carry.
  const local = newestLocalPromotable(adaptersDir);
  if (local && graph.writable) {
    const remote = await graph.latestAdapter();
    const meshHasItOrNewer = remote !== null && remote.version >= local.version;
    if (!meshHasItOrNewer && !published.has(local.version)) {
      try {
        const manifest = JSON.parse(readFileSync(local.manifestPath, "utf-8")) as unknown;
        await graph.publishAdapter({ ggufPath: local.ggufPath, version: local.version, baseModel: local.manifest.baseModel, evalDelta: local.manifest.evalDelta, manifest, manifestMirrorPath: local.manifestPath });
        published.add(local.version);
        result.published = local.version;
        log(`🌐 published adapter ${local.version} to the mesh — peers can pull it now`);
      } catch (err) {
        log(`⚠️  adapter publish failed: ${String(err)}`);
      }
    } else if (remote) {
      published.add(remote.version); // already out there — don't republish on the next pass
    }
  }

  // 2. FETCH the newest mesh adapter we don't have on disk yet.
  const remote = await graph.latestAdapter();
  if (remote && !haveLocally(adaptersDir, remote.version)) {
    try {
      const fetched = await graph.fetchLatestAdapter({ destDir: join(adaptersDir, remote.version), timeoutMs: 60_000 });
      if (fetched) {
        result.fetched = fetched.version;
        log(`🌐 fetched adapter ${fetched.version} from the mesh → ${join(adaptersDir, fetched.version)} (sha256 verified)`);
      }
    } catch (err) {
      log(`⚠️  adapter fetch failed (will retry next pass): ${String(err)}`);
    }
  }
  return result;
}

export interface AdapterSyncHandle {
  stop(): void;
}

/** Start the publish/fetch loop on a live, swarm-joined MeshGraph. */
export function startAdapterSync(graph: MeshGraph, opts: { audit?: AuditLog; intervalMs?: number; adaptersDir?: string } = {}): AdapterSyncHandle {
  const intervalMs = opts.intervalMs ?? 30_000;
  const publishedThisSession = new Set<string>();
  const pass = () => syncAdaptersOnce(graph, { audit: opts.audit, adaptersDir: opts.adaptersDir, publishedThisSession, log: true });

  console.log(`🌐 adapter sync active (every ${Math.round(intervalMs / 1000)}s): publish local promotable adapters · fetch peers' newer ones`);
  const id = setInterval(() => void pass().catch(() => {}), intervalMs);
  if (typeof id.unref === "function") id.unref();
  void pass();
  return { stop: () => clearInterval(id) };
}
