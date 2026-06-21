/**
 * THE single source of truth for per-device path scoping + the process env boundary.
 *
 * Imported by both the supervisor (`server-launch.mjs`, which the desktop app spawns too)
 * and the launcher helpers — so there is exactly ONE definition of where a device's local
 * data lives and which env vars isolate a process. Plain ESM (no TypeScript) so the launcher
 * can run it with bare `node`.
 *
 * Layout: by default, `<base>/Leash/<userId>/data/*` holds the full device-local workspace
 * (db, qvac cache, config, cloned MCP repos, chats, notes, downloads, etc.). If
 * `LEASH_DATA_ROOT` is set, the workspace root moves to `<LEASH_DATA_ROOT>/<userId>/*`.
 * Model weights live at `models/`; registry/rag stores sit beside them under the same data root.
 * Shared launcher state stays at `<base>/Leash/` level (`active.json`, runtime seed, shared npm cache).
 */
import { join } from "node:path";

export const BOOTSTRAP_USER = "_bootstrap";

/** `<base>/Leash` — the LEASH_BASE_DIR every scope shares (registry + active.json live here). */
export function leashBaseFrom(base) {
  return join(base, "Leash");
}

export function sharedNpmCache(leashBase) {
  return join(leashBase, "_shared", "npm-cache");
}
export function runtimeDir(leashBase) {
  return join(leashBase, "_runtime");
}
export function registryFile(leashBase) {
  return join(leashBase, "users.json");
}
export function activeFile(leashBase) {
  return join(leashBase, "active.json");
}

/** Every per-user path under the derived device data root. */
export function userScope(leashBase, userId, dataRoot = process.env["LEASH_DATA_ROOT"]) {
  const scopeDir = join(leashBase, userId);
  const dataDir = dataRoot ? join(dataRoot, userId) : join(scopeDir, "data");
  return {
    userId,
    scopeDir,
    dataDir,
    dbPath: join(dataDir, "db", "newsroom.db"),
    qvacHome: dataDir,
    configPath: join(dataDir, "qvac.config.mjs"),
    chatDir: join(dataDir, "leash-chats"),
    notesDir: join(dataDir, "notes"),
    feedbackFile: join(dataDir, "leash-feedback.jsonl"),
    mcpReposDir: join(dataDir, ".leash-mcp-repos"),
    hyphaDataDir: join(dataDir, "hypha"),
    modelsDir: join(dataDir, "models"),
  };
}

export function bootstrapScope(leashBase) {
  return userScope(leashBase, BOOTSTRAP_USER);
}

/**
 * The isolation boundary: the full env set scoping ONE process to ONE device workspace. Setting
 * HOME to `data/` keeps hidden tool state inside the device folder, while `QVAC_CONFIG_PATH` +
 * `QVAC_MODELS_DIR` pin model storage to `data/models` and the SDK's registry/rag stores beside
 * it. Deleting `data/` fully clears the local workspace. `npm_config_cache` stays shared so the
 * qvac CLI downloads once. LEASH_ACTIVE_USER is omitted for bootstrap so the dashboard stays
 * gated pre-setup.
 */
export function userEnv(leashBase, scope) {
  const env = {
    HOME: scope.qvacHome,
    LEASH_BASE_DIR: leashBase,
    LEASH_DATA_DIR: scope.dataDir,
    LEASH_DB_PATH: scope.dbPath,
    DATABASE_URL: `file:${scope.dbPath}`,
    QVAC_CONFIG_PATH: scope.configPath,
    QVAC_MODELS_DIR: scope.modelsDir,
    LEASH_CHAT_DIR: scope.chatDir,
    LEASH_NOTES_DIR: scope.notesDir,
    LEASH_FEEDBACK_FILE: scope.feedbackFile,
    LEASH_MCP_REPOS_DIR: scope.mcpReposDir,
    HYPHA_DATA_DIR: scope.hyphaDataDir,
    LEASH_ACTIVITY_LOG: join(scope.dataDir, "leash-activity.jsonl"),
    LEASH_TASKS_FILE: join(scope.dataDir, "leash-tasks.json"),
    LEASH_RESEARCH_DIR: join(scope.dataDir, "leash-research"),
    LEASH_DOWNLOADS_DIR: join(scope.dataDir, "leash-downloads"),
    LEASH_MODELS_CATALOG: join(scope.dataDir, "leash-models-catalog.json"),
    LEASH_PHOTOS_DIR: join(scope.dataDir, "photos"),
    LEASH_PHOTO_TAGS: join(scope.dataDir, "leash-photo-tags.json"),
    LEASH_SOUL_FILE: join(scope.dataDir, "soul.md"),
    LEASH_GOALS_FILE: join(scope.dataDir, "goals.md"),
    LEASH_HEARTBEAT_FILE: join(scope.dataDir, "heartbeat.md"),
    npm_config_cache: sharedNpmCache(leashBase),
  };
  if (scope.userId !== BOOTSTRAP_USER) env.LEASH_ACTIVE_USER = scope.userId;
  return env;
}
