/** Shared paths / constants for the newsroom daemon. */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** Repo root (apps/newsroom/src → ../../..). */
export const REPO_ROOT = join(here, "..", "..", "..");

/** The user's private graph sources (shared with the hub). Power the PERSONAL brief. */
export const NOTES_DIR = join(REPO_ROOT, "data", "notes");
export const VOICE_DIR = join(REPO_ROOT, "data", "voice");
export const PHOTOS_DIR = join(REPO_ROOT, "data", "photos");

/** The newsroom's own local copy of the personal graph (JSONL, additive). */
export const PERSONAL_GRAPH_FILE = join(here, "..", "data", "personal-graph.jsonl");

/** Audit JSONL (source: "newsroom"). */
export const LOG_DIR = join(here, "..", "logs");

/** Diffusion hero images land in the web app's public/ so Next serves them at /hero/<id>.png. */
export const HERO_DIR = join(REPO_ROOT, "apps", "web", "public", "hero");

/** Per-article RAG workspace name. Each article is grounded ONLY in its own pack. */
export function workspaceFor(articleId: string): string {
  return `understory-${articleId}`;
}

/** The paper's name (overridable; mirrored into DaemonState.masthead). */
export const DEFAULT_MASTHEAD = process.env["UNDERSTORY_MASTHEAD"] ?? "The Understory";

/** Default newsroom cadence (minutes between discovery ticks). */
export const DEFAULT_CADENCE_MIN = Number(process.env["UNDERSTORY_CADENCE_MIN"] ?? "60");

/**
 * The edition date as YYYY-MM-DD. Normally the real local date; set
 * `UNDERSTORY_DATE=YYYY-MM-DD` to backfill a *past* edition — the whole pipeline
 * (discover → research → draft → review → image → publish) then dates its output to
 * that day. The override is validated; a malformed value falls back to the real date.
 */
export function today(): string {
  const override = process.env["UNDERSTORY_DATE"];
  if (override && /^\d{4}-\d{2}-\d{2}$/.test(override)) return override;
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
