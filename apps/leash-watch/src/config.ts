/**
 * Env + defaults + paths for the Leash screen watcher.
 *
 * Everything is local: the activity trail is shared with the web tools (`active_context`
 * / `activity_recent`) and the `search_graph` embeddings ingest, so the path here must
 * match `apps/web/lib/leash/graph.ts` (both default to `<repo>/data/leash-activity.jsonl`).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** apps/leash-watch/src → repo root (../../..). */
export const REPO_ROOT = join(here, "..", "..", "..");
/** apps/leash-watch (../). */
const APP_ROOT = join(here, "..");

/** The activity trail (shared with the web tools + graph ingest). Override: LEASH_ACTIVITY_LOG. */
export const ACTIVITY_LOG = process.env["LEASH_ACTIVITY_LOG"] ?? join(REPO_ROOT, "data", "leash-activity.jsonl");
/** Audit JSONL dir (source: "leash-watch" → logs/leash-watch.jsonl). */
export const LOG_DIR = join(APP_ROOT, "logs");

/** Where `qvac serve openai` listens (OpenAI-compatible; same default as the web provider). */
export const QVAC_OPENAI_URL = process.env["QVAC_OPENAI_URL"] ?? "http://127.0.0.1:11435/v1";
/** Vision-language model alias (must match `qvac.config.json` → `serve.models`). */
export const VISION_MODEL = process.env["LEASH_VISION_MODEL"] ?? "qwen3vl";

/** Capture cadence — seconds between ticks. */
export const INTERVAL_SEC = Number(process.env["LEASH_WATCH_INTERVAL_SEC"] ?? 60);
/** Skip a tick when the user has been idle (away/locked) at least this long. */
export const IDLE_SKIP_SEC = Number(process.env["LEASH_WATCH_IDLE_SKIP_SEC"] ?? 120);
/** Temp frame path — the PNG is deleted right after each capture (no residual frames). */
export const FRAME_PATH = process.env["LEASH_WATCH_FRAME"] ?? "/tmp/leash/frame.png";
/** Vision request timeout (a cold VLM can take a while on first call). */
export const VISION_TIMEOUT_MS = Number(process.env["LEASH_WATCH_VISION_TIMEOUT_MS"] ?? 60000);

const csv = (v: string | undefined): string[] =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const ALLOW = csv(process.env["LEASH_WATCH_ALLOW"]);
const BLOCK = csv(process.env["LEASH_WATCH_BLOCK"]);

/**
 * Privacy gate by app name. Blocklist wins; with a non-empty allowlist only listed apps
 * are watched; with neither set, everything is allowed. (e.g. LEASH_WATCH_BLOCK="1Password,Messages")
 */
export function appAllowed(app: string): boolean {
  const name = app.trim().toLowerCase();
  if (BLOCK.some((b) => b.toLowerCase() === name)) return false;
  if (ALLOW.length > 0) return ALLOW.some((a) => a.toLowerCase() === name);
  return true;
}
