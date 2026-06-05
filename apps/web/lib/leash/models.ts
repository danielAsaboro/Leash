/**
 * Model-layer reads for the dashboard (server-only) — HTTP + filesystem only, no
 * `@qvac/sdk` in the Next process (SDK work runs in spawned tsx children; see
 * `scripts/leash-model-*.mts`).
 *
 * The serve doesn't open its port until preload completes, so a `/v1/models` answer
 * is a clean "fully ready" health signal; refusal = stopped/starting. `/v1/models`
 * lists READY models only.
 */
import "server-only";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { readJson, readJsonCached, writeJson, invalidateJsonCache, DATA_DIR } from "./json-store.ts";
import { estimateFit, type FitEstimate } from "./hwfit.ts";

/** Where `qvac serve openai` listens (same default as the provider). */
export const QVAC_OPENAI_URL = process.env["QVAC_OPENAI_URL"] ?? "http://127.0.0.1:11435/v1";

/** The SDK's model cache (`~/.qvac/models`; symlinked to the external SSD on this Mac). */
export const QVAC_MODELS_DIR = process.env["QVAC_MODELS_DIR"] ?? join(homedir(), ".qvac", "models");

/** The serve's config — the `serve.models` set Leash edits (load = config + restart). */
export const QVAC_CONFIG_FILE = process.env["QVAC_CONFIG_PATH"] ?? join(DATA_DIR, "..", "qvac.config.json");

/** The SDK catalog dump written by `scripts/leash-model-catalog.mts` (spawned child). */
export const CATALOG_FILE = process.env["LEASH_MODELS_CATALOG"] ?? join(DATA_DIR, "leash-models-catalog.json");

export interface LiveModels {
  /** Whether the serve answered `/v1/models` (port open ⇒ preload finished). */
  up: boolean;
  /** READY model aliases (empty when down). */
  ready: string[];
}

/** Probe the serve: READY aliases, or `up:false` on refusal/timeout (1.5s cap). */
export async function liveModels(): Promise<LiveModels> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const res = await fetch(`${QVAC_OPENAI_URL}/models`, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) return { up: false, ready: [] };
    const body = (await res.json()) as { data?: { id: string }[] };
    return { up: true, ready: (body.data ?? []).map((m) => m.id) };
  } catch {
    return { up: false, ready: [] };
  } finally {
    clearTimeout(timer);
  }
}

export interface DiskFile {
  file: string;
  bytes: number;
}

export interface DiskUsage {
  files: DiskFile[];
  totalBytes: number;
}

/** Scan the model cache directory (flat files; missing dir → empty). */
export async function modelsDiskUsage(): Promise<DiskUsage> {
  let names: string[];
  try {
    names = await readdir(QVAC_MODELS_DIR);
  } catch {
    return { files: [], totalBytes: 0 };
  }
  const files: DiskFile[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    try {
      const s = await stat(join(QVAC_MODELS_DIR, name));
      if (s.isFile()) files.push({ file: name, bytes: s.size });
    } catch {
      /* raced a delete — skip */
    }
  }
  files.sort((a, b) => b.bytes - a.bytes);
  return { files, totalBytes: files.reduce((n, f) => n + f.bytes, 0) };
}

/** "4.9 GB" / "382 MB" — display formatting for byte sizes. */
export function fmtBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}

// ── Inventory merge: catalog + qvac.config.json + disk + live ─────────────────

/** One catalog entry from the SDK dump (see scripts/leash-model-catalog.mts). */
export interface CatalogModel {
  name: string;
  addon: string;
  engine?: string;
  params?: string;
  quantization?: string;
  expectedSize?: number;
  registryPath?: string;
  cacheFile?: string;
  /** Device-fit verdict (added by `catalogWithFit`, not in the on-disk dump). */
  fit?: FitEstimate;
}

interface CatalogFile {
  generatedAt: number;
  models: CatalogModel[];
}

/** A `serve.models` entry as written in qvac.config.json (both shapes). */
export interface ServeModelEntry {
  /** SDK constant name (constant shape). */
  model?: string;
  /** Raw file path / registry src (explicit shape — e.g. medpsy). */
  src?: string;
  type?: string;
  preload?: boolean;
  default?: boolean;
  config?: Record<string, unknown>;
}

export interface QvacConfig {
  serve?: { models?: Record<string, ServeModelEntry | string> };
  [k: string]: unknown;
}

/** The catalog with a device-fit verdict on each entry (for the download picker). */
export async function catalogWithFit(): Promise<CatalogModel[]> {
  return (await readCatalog()).map((c) => ({
    ...c,
    fit: estimateFit({ expectedSize: c.expectedSize, params: c.params, quantization: c.quantization }),
  }));
}

/** The SDK catalog (mtime-cached; `[]` until the dump script has run). */
export async function readCatalog(): Promise<CatalogModel[]> {
  const raw = await readJsonCached<CatalogFile | null>(CATALOG_FILE, null);
  return raw?.models ?? [];
}

/** qvac.config.json, leniently (mtime-cached; tolerates hand-edits). */
export async function readQvacConfig(): Promise<QvacConfig> {
  return readJsonCached<QvacConfig>(QVAC_CONFIG_FILE, {});
}

/** One row of the dashboard's model inventory. */
export interface InventoryRow {
  /** Catalog constant name, or the config alias / file basename for explicit entries. */
  name: string;
  /** serve.models alias when configured. */
  alias: string | null;
  addon: string | null;
  engine: string | null;
  params: string | null;
  quantization: string | null;
  /** Context window from the config entry's `config.ctx_size` (configured rows only). */
  ctxSize: number | null;
  /** Median measured tok/s from real chat telemetry (null until the alias has turns). */
  tokPerSec: number | null;
  /** Will it run on this machine (per-model, in isolation)? */
  fit: FitEstimate;
  /** Expected download size (catalog) — null for explicit-src entries. */
  expectedSize: number | null;
  /** Cache filename (catalog-derived) or the raw path basename. */
  cacheFile: string | null;
  /** Bytes on disk, or null if not downloaded. */
  onDiskBytes: number | null;
  inConfig: boolean;
  preload: boolean;
  isDefault: boolean;
  /** READY on the live serve right now. */
  loaded: boolean;
}

export interface ModelsInventory {
  serve: LiveModels;
  /** Models referenced by qvac.config.json (the serve set). */
  configured: InventoryRow[];
  /** Cached files on disk not referenced by the config (catalog-identified when possible). */
  onDiskOnly: InventoryRow[];
  /** Full catalog size (the download picker fetches the catalog separately). */
  catalogCount: number;
  totalDiskBytes: number;
}

/** Merge catalog + config + disk scan + live serve into the dashboard inventory. */
export async function modelsInventory(): Promise<ModelsInventory> {
  const [catalog, config, disk, live, speeds] = await Promise.all([readCatalog(), readQvacConfig(), modelsDiskUsage(), liveModels(), measuredSpeeds()]);
  const byName = new Map(catalog.map((c) => [c.name, c]));
  const byCacheFile = new Map(catalog.filter((c) => c.cacheFile).map((c) => [c.cacheFile as string, c]));
  const diskByFile = new Map(disk.files.map((f) => [f.file, f.bytes]));
  const ready = new Set(live.ready);

  const configured: InventoryRow[] = [];
  const claimedFiles = new Set<string>();
  for (const [alias, rawEntry] of Object.entries(config.serve?.models ?? {})) {
    const entry: ServeModelEntry = typeof rawEntry === "string" ? { model: rawEntry } : rawEntry;
    const constant = entry.model ? byName.get(entry.model) : undefined;
    // Explicit-src entries: a raw path under the cache dir maps straight to its basename.
    const srcBase = entry.src ? basename(entry.src) : null;
    const cacheFile = constant?.cacheFile ?? srcBase;
    if (cacheFile) claimedFiles.add(cacheFile);
    const ctxRaw = entry.config?.["ctx_size"];
    configured.push({
      name: entry.model ?? srcBase ?? alias,
      alias,
      addon: constant?.addon ?? entry.type ?? null,
      engine: constant?.engine ?? null,
      params: constant?.params ?? null,
      quantization: constant?.quantization ?? null,
      ctxSize: typeof ctxRaw === "number" ? ctxRaw : null,
      tokPerSec: speeds.get(alias) ?? null,
      fit: estimateFit({ expectedSize: constant?.expectedSize ?? diskByFile.get(cacheFile ?? "") ?? null, params: constant?.params, quantization: constant?.quantization, ctx: typeof ctxRaw === "number" ? ctxRaw : undefined }),
      expectedSize: constant?.expectedSize ?? null,
      cacheFile,
      onDiskBytes: cacheFile ? (diskByFile.get(cacheFile) ?? null) : null,
      inConfig: true,
      preload: entry.preload !== false,
      isDefault: entry.default === true,
      loaded: ready.has(alias),
    });
  }

  const onDiskOnly: InventoryRow[] = disk.files
    .filter((f) => !claimedFiles.has(f.file))
    .map((f) => {
      const constant = byCacheFile.get(f.file);
      return {
        name: constant?.name ?? f.file,
        alias: null,
        addon: constant?.addon ?? null,
        engine: constant?.engine ?? null,
        params: constant?.params ?? null,
        quantization: constant?.quantization ?? null,
        ctxSize: null,
        tokPerSec: null,
        fit: estimateFit({ expectedSize: constant?.expectedSize ?? f.bytes, params: constant?.params, quantization: constant?.quantization }),
        expectedSize: constant?.expectedSize ?? null,
        cacheFile: f.file,
        onDiskBytes: f.bytes,
        inConfig: false,
        preload: false,
        isDefault: false,
        loaded: false,
      };
    });

  return { serve: live, configured, onDiskOnly, catalogCount: catalog.length, totalDiskBytes: disk.totalBytes };
}

// ── Measured generation speed (from real chat telemetry) ───────────────────────
// Every assistant message stores {model, totalTokens, createdAt, finishedAt} metadata
// (chat route `messageMetadata`). Median tok/s of the last 10 turns per alias — a
// MEASURED number, not a spec sheet; null until an alias has real turns.

const CHAT_DIR = process.env["LEASH_CHAT_DIR"] ?? join(DATA_DIR, "leash-chats");

interface SpeedSample {
  finishedAt: number;
  tokPerSec: number;
}

let speedsCache: { fingerprint: string; speeds: Map<string, number> } | null = null;

/** Median measured tok/s per model alias (cache keyed on chat-dir count + max mtime). */
export async function measuredSpeeds(): Promise<Map<string, number>> {
  let files: string[];
  try {
    files = (await readdir(CHAT_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    return new Map();
  }
  let maxMtime = 0;
  for (const f of files) {
    try {
      maxMtime = Math.max(maxMtime, (await stat(join(CHAT_DIR, f))).mtimeMs);
    } catch {
      /* raced a delete */
    }
  }
  const fingerprint = `${files.length}:${maxMtime}`;
  if (speedsCache && speedsCache.fingerprint === fingerprint) return speedsCache.speeds;

  const samples = new Map<string, SpeedSample[]>();
  for (const f of files) {
    const rec = await readJson<{ messages?: { role: string; metadata?: { model?: string; totalTokens?: number; createdAt?: number; finishedAt?: number } }[] } | null>(
      join(CHAT_DIR, f),
      null,
    );
    for (const m of rec?.messages ?? []) {
      const md = m.metadata;
      if (m.role !== "assistant" || !md?.model || !md.totalTokens || !md.createdAt || !md.finishedAt) continue;
      const secs = (md.finishedAt - md.createdAt) / 1000;
      if (secs <= 0.2 || md.totalTokens < 5) continue; // skip degenerate samples
      let list = samples.get(md.model);
      if (!list) {
        list = [];
        samples.set(md.model, list);
      }
      list.push({ finishedAt: md.finishedAt, tokPerSec: md.totalTokens / secs });
    }
  }
  const speeds = new Map<string, number>();
  for (const [alias, list] of samples) {
    const recent = list.sort((a, b) => b.finishedAt - a.finishedAt).slice(0, 10).map((s) => s.tokPerSec).sort((a, b) => a - b);
    const mid = Math.floor(recent.length / 2);
    const median = recent.length % 2 ? (recent[mid] as number) : ((recent[mid - 1] as number) + (recent[mid] as number)) / 2;
    speeds.set(alias, median);
  }
  speedsCache = { fingerprint, speeds };
  return speeds;
}

// ── Download status files (written by scripts/leash-model-download.mts) ────────

export const DOWNLOADS_DIR = process.env["LEASH_DOWNLOADS_DIR"] ?? join(DATA_DIR, "leash-downloads");

export interface DownloadStatus {
  name: string;
  state: "starting" | "downloading" | "done" | "error";
  percentage: number;
  downloaded: number;
  total: number;
  error?: string;
  pid: number;
  startedAt: number;
  updatedAt: number;
}

/** Is a recorded download pid still alive? (signal-0 probe) */
export function downloadPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Mark statuses whose process died as honest errors (crash / reboot mid-download). */
function settle(s: DownloadStatus): DownloadStatus {
  const stale = (s.state === "downloading" || s.state === "starting") && !downloadPidAlive(s.pid);
  return stale ? { ...s, state: "error", error: "download process died — start it again" } : s;
}

/** One download's status, or null. */
export async function readDownload(name: string): Promise<DownloadStatus | null> {
  const s = await readJson<DownloadStatus | null>(join(DOWNLOADS_DIR, `${name}.json`), null);
  return s ? settle(s) : null;
}

/** All download statuses, newest first. */
export async function listDownloads(): Promise<DownloadStatus[]> {
  let files: string[] = [];
  try {
    files = (await readdir(DOWNLOADS_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const all = (await Promise.all(files.map((f) => readJson<DownloadStatus | null>(join(DOWNLOADS_DIR, f), null)))).filter(
    (s): s is DownloadStatus => s !== null,
  );
  return all.map(settle).sort((a, b) => b.startedAt - a.startedAt);
}

// ── qvac.config.json edits (the "load a model" half of the lifecycle) ──────────
// There is NO HTTP load endpoint on the serve: loading = add the alias here +
// restart the serve. Edits go through a promise-mutex with a FRESH read per edit
// and an atomic rename, so concurrent dashboard clicks and hand-edits never lose
// data. Everything outside `serve.models[alias]` is preserved verbatim.

let configMutex: Promise<unknown> = Promise.resolve();
function withConfigLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = configMutex.then(fn, fn);
  configMutex = run.catch(() => undefined);
  return run;
}

/** Add (or replace) one `serve.models` alias pointing at an SDK catalog constant. */
export async function addModelToConfig(alias: string, modelName: string): Promise<{ ok: boolean; error?: string }> {
  if (!/^[a-z0-9][a-z0-9-]{0,32}$/.test(alias)) return { ok: false, error: "alias must be short lowercase [a-z0-9-]" };
  const catalog = await readCatalog();
  if (!catalog.some((c) => c.name === modelName)) return { ok: false, error: `"${modelName}" is not in the SDK catalog` };
  return withConfigLock(async () => {
    const config = await readJson<QvacConfig>(QVAC_CONFIG_FILE, {});
    config.serve ??= {};
    config.serve.models ??= {};
    config.serve.models[alias] = { model: modelName, preload: true };
    await writeJson(QVAC_CONFIG_FILE, config);
    invalidateJsonCache(QVAC_CONFIG_FILE);
    return { ok: true };
  });
}

/** Remove one `serve.models` alias (applies on the next serve restart). */
export async function removeModelFromConfig(alias: string): Promise<{ ok: boolean; error?: string }> {
  return withConfigLock(async () => {
    const config = await readJson<QvacConfig>(QVAC_CONFIG_FILE, {});
    if (!config.serve?.models?.[alias]) return { ok: false, error: `no serve.models alias "${alias}"` };
    delete config.serve.models[alias];
    await writeJson(QVAC_CONFIG_FILE, config);
    invalidateJsonCache(QVAC_CONFIG_FILE);
    return { ok: true };
  });
}
