/**
 * THE single source of truth for per-user path scoping + the process env boundary.
 *
 * Imported by both the supervisor (`server-launch.mjs`, which the desktop app spawns too)
 * and the migration tool — so there is exactly ONE definition of where a user's data lives
 * and which env vars isolate a process. Plain ESM (no TypeScript) so the launcher can run it
 * with bare `node`, and `userId` is minted only by `auth-core.ts#slugifyUserId`.
 *
 * Layout: `<base>/Leash/<userId>/{data,db,.qvac,qvac.config.mjs,…}`, with the auth registry,
 * `active.json`, the shared Next runtime and a shared npm cache at `<base>/Leash/` level.
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

/** Every per-user path under `<leashBase>/<userId>/`. */
export function userScope(leashBase, userId) {
  const scopeDir = join(leashBase, userId);
  const dataDir = join(scopeDir, "data");
  return {
    userId,
    scopeDir,
    dataDir,
    dbPath: join(scopeDir, "db", "newsroom.db"),
    qvacHome: scopeDir,
    qvacDir: join(scopeDir, ".qvac"),
    configPath: join(scopeDir, "qvac.config.mjs"),
    chatDir: join(dataDir, "leash-chats"),
    notesDir: join(dataDir, "notes"),
    feedbackFile: join(dataDir, "leash-feedback.jsonl"),
    mcpReposDir: join(scopeDir, ".leash-mcp-repos"),
    hyphaDataDir: join(dataDir, "hypha"),
    modelsDir: join(scopeDir, ".qvac", "models"),
  };
}

export function bootstrapScope(leashBase) {
  return userScope(leashBase, BOOTSTRAP_USER);
}

/**
 * The isolation boundary: the full env set scoping ONE process to ONE user. Setting HOME scopes
 * all of `~/.qvac` (models, registry-corestore, rag-hyperdb, adapters) and `~/.leash-mcp-repos`;
 * the chat/notes/feedback/etc. keys are pinned because their web-side / spawned-script defaults
 * are bundle- or ROOT-relative (the leak). `npm_config_cache` is SHARED so the qvac CLI downloads
 * once. LEASH_ACTIVE_USER is omitted for bootstrap so the dashboard stays gated pre-login.
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
