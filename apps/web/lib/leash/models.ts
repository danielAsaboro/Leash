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
import { readdir, realpath, stat, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { readJson, readJsonCached, writeJson, invalidateJsonCache, DATA_DIR } from "./json-store.ts";
import { estimateFit, type FitEstimate } from "./hwfit.ts";
import { ASSISTANT_KIT, kitRoleOf, type KitRole, type KitRoleName } from "./kit.ts";

/** Where `qvac serve openai` listens (same default as the provider). */
export const QVAC_OPENAI_URL = process.env["QVAC_OPENAI_URL"] ?? "http://127.0.0.1:11435/v1";

/** The SDK's model cache (`~/.qvac/models`; on some machines symlinked to an external SSD). */
export const QVAC_MODELS_DIR = process.env["QVAC_MODELS_DIR"] ?? join(homedir(), ".qvac", "models");

/**
 * Where the model cache REALLY lives — follows the `~/.qvac` symlink when present
 * ("external SSD · <volume>") instead of hardcoding one machine's setup.
 */
export async function modelsDirLocation(): Promise<string> {
  try {
    const real = await realpath(QVAC_MODELS_DIR);
    const vol = /^\/Volumes\/([^/]+)/.exec(real);
    return vol ? `external SSD · ${vol[1]}` : "internal SSD";
  } catch {
    return "internal SSD";
  }
}

/**
 * The serve's config DATA — the `serve.models` set Leash edits (load = config + restart).
 * NOTE: Leash edits the machine-neutral base JSON; the serve loads `qvac.config.mjs` (the wrapper
 * that expands `~/` paths and reads the base JSON beside it). QVAC_CONFIG_PATH points at the .mjs
 * WRAPPER (what the CLI loads) — so we edit the `qvac.config.base.json` sibling, NOT the wrapper
 * itself (writing JSON over the .mjs corrupts it → "Unexpected token ':'" on serve).
 */
export const QVAC_CONFIG_FILE = process.env["QVAC_CONFIG_PATH"]
  ? join(dirname(process.env["QVAC_CONFIG_PATH"]), "qvac.config.base.json")
  : join(DATA_DIR, "..", "qvac.config.base.json");

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

// ── Inventory merge: catalog + qvac.config.base.json + disk + live ─────────────────

/** One catalog entry from the SDK dump (see scripts/leash-model-catalog.mts). */
export interface CatalogModel {
  name: string;
  /** Authoritative use-case from @qvac/ai-sdk-provider (chat/embedding/transcription/speech/image/ocr/translation). */
  endpointCategory?: string;
  addon?: string;
  engine?: string;
  params?: string;
  quantization?: string;
  expectedSize?: number;
  registryPath?: string;
  cacheFile?: string;
  /** Device-fit verdict (added by `catalogWithFit`, not in the on-disk dump). */
  fit?: FitEstimate;
  /** Assistant-Kit role this SKU fills, if any (added by `catalogWithFit`, not in the on-disk dump). */
  role?: KitRoleName;
}

interface CatalogFile {
  generatedAt: number;
  models: CatalogModel[];
}

/** A `serve.models` entry as written in qvac.config.base.json (both shapes). */
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
    ...(kitRoleOf(c.name) ? { role: kitRoleOf(c.name) } : {}),
  }));
}

/** The SDK catalog (mtime-cached; `[]` until the dump script has run). */
export async function readCatalog(): Promise<CatalogModel[]> {
  const raw = await readJsonCached<CatalogFile | null>(CATALOG_FILE, null);
  return raw?.models ?? [];
}

/** qvac.config.base.json, leniently (mtime-cached; tolerates hand-edits). */
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
  /** `config.use_gpu` — true = GPU, false = CPU, null = unset (SDK default). */
  useGpu: boolean | null;
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
  /** Models referenced by qvac.config.base.json (the serve set). */
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
    const gpuRaw = entry.config?.["use_gpu"];
    configured.push({
      name: entry.model ?? srcBase ?? alias,
      alias,
      addon: constant?.addon ?? entry.type ?? null,
      engine: constant?.engine ?? null,
      params: constant?.params ?? null,
      quantization: constant?.quantization ?? null,
      ctxSize: typeof ctxRaw === "number" ? ctxRaw : null,
      useGpu: typeof gpuRaw === "boolean" ? gpuRaw : null,
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
        useGpu: null,
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
  /** model = weights (per-user, this process's child); system = runtime/daemon overlay (Electron main). */
  kind?: "model" | "system";
  /** Human label for the Downloads view (system downloads set this; models use `name`). */
  label?: string;
  state: "starting" | "downloading" | "done" | "error" | "cancelled";
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

/** System (runtime / daemon overlay) downloads, written by the Electron main into <leashBase>/_deps/downloads.
 *  Their state is authored by the main (it manages its own retries) — no pid-death settling here.
 *  Anchored on LEASH_BASE_DIR (the canonical `<home>/Leash` the supervisor exports) — deps.ts writes to
 *  `join(leashBase, "_deps", "downloads")`, so we must read the SAME dir (an earlier `join(LEASH_BASE,
 *  "Leash", …)` double-counted the suffix → the dir never matched → mesh/runtime downloads were invisible). */
export const SYSTEM_DOWNLOADS_DIR = process.env["LEASH_BASE_DIR"]
  ? join(process.env["LEASH_BASE_DIR"], "_deps", "downloads")
  : null;

export async function listSystemDownloads(): Promise<DownloadStatus[]> {
  if (!SYSTEM_DOWNLOADS_DIR) return [];
  let files: string[] = [];
  try {
    files = (await readdir(SYSTEM_DOWNLOADS_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const all = (await Promise.all(files.map((f) => readJson<DownloadStatus | null>(join(SYSTEM_DOWNLOADS_DIR, f), null)))).filter(
    (s): s is DownloadStatus => s !== null,
  );
  return all.map((s) => ({ ...s, kind: "system" as const })).sort((a, b) => b.startedAt - a.startedAt);
}

/** Model + system downloads, unified for the Tasks → Downloads view (newest first). */
export async function listAllDownloads(): Promise<DownloadStatus[]> {
  const [models, system] = await Promise.all([listDownloads(), listSystemDownloads()]);
  return [...models.map((s) => ({ ...s, kind: "model" as const })), ...system].sort((a, b) => b.startedAt - a.startedAt);
}

/** Ask the Electron main to retry/cancel a system download — writes a sentinel it polls for. */
export async function requestSystemControl(name: string, op: "retry" | "cancel"): Promise<boolean> {
  if (!SYSTEM_DOWNLOADS_DIR || !/^[a-z0-9-]+$/i.test(name)) return false;
  try {
    await writeJson(join(SYSTEM_DOWNLOADS_DIR, `${name}.${op}`), { at: Date.now() });
    return true;
  } catch {
    return false;
  }
}

/** Cancel a model download: kill its detached child (pid in the status file) but KEEP a "cancelled"
 *  record — a cancelled download stays in Tasks as a "dropped" row with a retry button, instead of
 *  vanishing forever with no way to restart it. */
export async function cancelDownload(name: string): Promise<boolean> {
  const s = await readDownload(name);
  if (s?.pid && downloadPidAlive(s.pid)) {
    try {
      process.kill(s.pid);
    } catch {
      /* already gone */
    }
  }
  // Remove the partial weight file(s) — modelsInventory counts ANY file in QVAC_MODELS_DIR as
  // on-disk, so an incomplete download left behind would masquerade as a "Downloaded" model. Clear
  // the catalog cacheFile and any of its partials (`<file>.part`, `.<file>.tmp`, …) so a cancelled
  // download fully disappears from the Models page (it stays in Tasks as a retryable "dropped" row).
  try {
    const cacheFile = (await readCatalog()).find((c) => c.name === name)?.cacheFile;
    if (cacheFile) {
      const onDisk = await readdir(QVAC_MODELS_DIR).catch(() => [] as string[]);
      await Promise.all(
        onDisk
          .filter((f) => f === cacheFile || f.startsWith(`${cacheFile}.`) || f.startsWith(`.${cacheFile}`))
          .map((f) => rm(join(QVAC_MODELS_DIR, f), { force: true })),
      );
    }
  } catch {
    /* advisory — never let cleanup break the cancel */
  }
  if (s) {
    try {
      await writeJson(join(DOWNLOADS_DIR, `${name}.json`), {
        ...s,
        state: "cancelled",
        error: "cancelled by you",
        updatedAt: Date.now(),
      });
    } catch {
      /* advisory */
    }
  }
  return true;
}

// ── qvac.config.base.json edits (the "load a model" half of the lifecycle) ──────────
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

/** Default context window for chat (text-generation) models. Embedding/speech/image/ocr/
 *  transcription models keep the SDK default — they don't use a large generation context. */
export const DEFAULT_CTX_SIZE = 32768;

/**
 * The serve's TTS config branch requires a `ttsEngine` discriminator (+ language/voice); the SDK does
 * NOT auto-populate it, so a speech model added without this `config` block FAILS to preload
 * (`Invalid input: expected "supertonic"`). Derived from the model name (the on-device voices today).
 */
function defaultSpeechConfig(modelName: string): Record<string, unknown> | null {
  if (/supertonic/i.test(modelName)) return { ttsEngine: "supertonic", language: "en", voice: "F1", ttsSpeed: 1.05, ttsNumInferenceSteps: 5 };
  if (/chatterbox/i.test(modelName)) return { ttsEngine: "chatterbox", language: "en" };
  return null;
}

/** The default per-model `config` block for a freshly-wired alias, by use-case:
 *  · chat → `tools:true` + `toolsMode:"dynamic"` (REQUIRED for tool calling: the serve's tools_compact
 *    path rejects toolless requests, and without it the assistant/agents/plugins can't call tools or
 *    delegate — the model just narrates tool use; see agent-runner.ts) + a 32768 context window.
 *  · speech (TTS) → the required engine config. Others (embeddings/image/transcription) need none. */
function defaultModelConfig(catalog: CatalogModel[], modelName: string): Record<string, unknown> | undefined {
  const cat = catalog.find((c) => c.name === modelName)?.endpointCategory;
  if (cat === "chat") return { tools: true, toolsMode: "dynamic", ctx_size: DEFAULT_CTX_SIZE };
  if (cat === "speech") return defaultSpeechConfig(modelName) ?? undefined;
  return undefined;
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
    // First model added becomes the default → the chat targets it (see provider.resolvedChatAlias).
    const hasDefault = Object.values(config.serve.models).some((m) => m && typeof m === "object" && (m as { default?: boolean }).default);
    // Per-use-case defaults: chat → ctx_size 32768; speech → the required ttsEngine config.
    const cfg = defaultModelConfig(catalog, modelName);
    config.serve.models[alias] = { model: modelName, preload: true, ...(hasDefault ? {} : { default: true }), ...(cfg ? { config: cfg } : {}) };
    // Co-wire the default embedding when adding a CHAT model with none configured. Skills activation
    // (semantic routing) and RAG/search_graph need an embedding model; without one they SILENTLY
    // degrade to lexical-only. Non-destructive (only when absent, and never overwrites a `gte-large`
    // alias); the weight auto-downloads from the registry on first preload (offline-after-warm).
    const catOf = (name: string | undefined): string | undefined => (name ? catalog.find((c) => c.name === name)?.endpointCategory : undefined);
    if (catOf(modelName) === "chat") {
      const hasEmbedding = Object.values(config.serve.models).some((m) => catOf(typeof m === "string" ? m : m.model) === "embedding");
      if (!hasEmbedding && !config.serve.models["gte-large"] && catalog.some((c) => c.name === "GTE_LARGE_FP16")) {
        config.serve.models["gte-large"] = { model: "GTE_LARGE_FP16", preload: true };
      }
    }
    await writeJson(QVAC_CONFIG_FILE, config);
    invalidateJsonCache(QVAC_CONFIG_FILE);
    return { ok: true };
  });
}

/**
 * Wire the whole Assistant Kit's aliases into qvac.config.base.json in one atomic edit.
 *
 * Validates EVERY referenced SKU (each role's primary weight + the vision mmproj projection)
 * exists in the SDK catalog first — all-or-nothing — so a half-resolved kit never writes a broken
 * alias. The vision role's `projectionModelSrc` is computed from the projection SKU's on-disk cache
 * filename (`~/.qvac/models/<cacheFile>`), which is exactly the bare-mmproj wiring the kit exists to
 * fix. The `chat` role becomes the served default UNLESS the user already has a default configured
 * (non-destructive, mirroring addModelToConfig). Weights are downloaded separately (the dashboard
 * queues them via /models/download); this only edits the config the serve loads on its next restart.
 */
export async function addModelKit(roles: KitRole[] = ASSISTANT_KIT): Promise<{ ok: boolean; error?: string }> {
  const catalog = await readCatalog();
  const has = (n: string): boolean => catalog.some((c) => c.name === n);
  for (const r of roles) {
    if (!/^[a-z0-9][a-z0-9-]{0,32}$/.test(r.alias)) return { ok: false, error: `bad kit alias "${r.alias}"` };
    if (!has(r.model)) return { ok: false, error: `"${r.model}" is not in the SDK catalog` };
    if (r.projection && !has(r.projection)) return { ok: false, error: `"${r.projection}" is not in the SDK catalog` };
  }
  return withConfigLock(async () => {
    const config = await readJson<QvacConfig>(QVAC_CONFIG_FILE, {});
    config.serve ??= {};
    config.serve.models ??= {};
    for (const r of roles) {
      // Per-use-case defaults (chat → ctx_size 32768; speech → the required ttsEngine config), then
      // the role's own config wins, then the computed mmproj projection path.
      const cfg: Record<string, unknown> = { ...defaultModelConfig(catalog, r.model), ...(r.config ?? {}) };
      if (r.projection) {
        const mm = catalog.find((c) => c.name === r.projection);
        if (mm?.cacheFile) cfg["projectionModelSrc"] = `~/.qvac/models/${mm.cacheFile}`;
      }
      config.serve.models[r.alias] = { model: r.model, preload: true, ...(Object.keys(cfg).length ? { config: cfg } : {}) };
    }
    // chat becomes the default only if nothing in the final config already claims it (preserve user intent).
    const anyDefault = Object.values(config.serve.models).some((m) => m && typeof m === "object" && (m as ServeModelEntry).default);
    if (!anyDefault) {
      const chat = roles.find((r) => r.role === "chat");
      if (chat) (config.serve.models[chat.alias] as ServeModelEntry).default = true;
    }
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

/**
 * Merge per-model serving fields (`ctx_size`, `use_gpu`, …) into one alias's `config` block in
 * qvac.config.base.json. Applies on the NEXT serve restart (the serve has no live-reconfig API).
 * A string entry (`"alias": "MODEL"`) is promoted to object form so it can carry `config`.
 */
export async function setModelConfigFields(alias: string, patch: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  if (!patch || typeof patch !== "object" || Object.keys(patch).length === 0) return { ok: false, error: "patch must be a non-empty object" };
  return withConfigLock(async () => {
    const config = await readJson<QvacConfig>(QVAC_CONFIG_FILE, {});
    const entry = config.serve?.models?.[alias];
    if (!entry) return { ok: false, error: `no serve.models alias "${alias}"` };
    const obj: ServeModelEntry = typeof entry === "string" ? { model: entry } : entry;
    obj.config = { ...(obj.config ?? {}), ...patch };
    config.serve!.models![alias] = obj;
    await writeJson(QVAC_CONFIG_FILE, config);
    invalidateJsonCache(QVAC_CONFIG_FILE);
    return { ok: true };
  });
}
