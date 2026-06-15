/**
 * Repo-anchored paths for the shared Leash core.
 *
 * Both the Next web process AND the standalone `leash-tools-mcp` daemon import this
 * package from its compiled `dist/`, at DIFFERENT nesting depths than the original
 * `apps/web/lib/leash/*` modules — so a hard-coded `../../../../data` no longer holds.
 * Instead we find the monorepo root by walking UP from this module until we hit the dir
 * that contains BOTH `apps/` and `packages/` (the npm-workspace root, unambiguous), then
 * anchor every data path there. `LEASH_DATA_DIR` still overrides, so a relocated data dir
 * (or a test fixture) works for both processes identically.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Walk up from this module to the workspace root (the dir with both `apps/` and `packages/`). */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "apps")) && existsSync(join(dir, "packages"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break; // hit the fs root
    dir = parent;
  }
  // Fallback: three levels up from packages/leash-core/dist → repo root.
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

/** The monorepo root (absolute). */
export const REPO_ROOT = findRepoRoot();

/** `mycelium/data` — where every Leash file-store lives (env-overridable). */
export const DATA_DIR = process.env["LEASH_DATA_DIR"] ?? join(REPO_ROOT, "data");

/** `data/notes` — the user's markdown notes (RAG over them). */
export const NOTES_DIR = process.env["LEASH_NOTES_DIR"] ?? join(DATA_DIR, "notes");

/** `data/leash-activity.jsonl` — the screen-watcher trail (written by `npm run watch`). */
export const ACTIVITY_LOG = process.env["LEASH_ACTIVITY_LOG"] ?? join(DATA_DIR, "leash-activity.jsonl");

/** `data/leash-chats` — one JSON per chat (same resolution as chat-store.ts). */
export const CHATS_DIR = process.env["LEASH_CHAT_DIR"] ?? join(DATA_DIR, "leash-chats");

/** `apps/web/public/leash-gen` — generated images, served by Next at `/leash-gen/*`. */
export const GEN_DIR = process.env["LEASH_GEN_DIR"] ?? join(REPO_ROOT, "apps", "web", "public", "leash-gen");

/** `data/leash-photo-tags.json` — on-device photo classifications (`npm run tag-photos`). */
export const PHOTO_TAGS = process.env["LEASH_PHOTO_TAGS"] ?? join(DATA_DIR, "leash-photo-tags.json");

/**
 * The "constitution" — three editable markdown files the proactive assistant judges everything
 * against. `soul.md` = who the user is; `goals.md` = where they're going (≤5 goals); `heartbeat.md`
 * = what to watch each cycle. Per-user-scoped via the LEASH_*_FILE env vars (see scope.mjs userEnv).
 */
export const SOUL_FILE = process.env["LEASH_SOUL_FILE"] ?? join(DATA_DIR, "soul.md");
export const GOALS_FILE = process.env["LEASH_GOALS_FILE"] ?? join(DATA_DIR, "goals.md");
export const HEARTBEAT_FILE = process.env["LEASH_HEARTBEAT_FILE"] ?? join(DATA_DIR, "heartbeat.md");
