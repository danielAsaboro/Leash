import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { leashBaseFrom, userEnv, userScope } from "../lib/leash/scope.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const leashBase = leashBaseFrom("/base");
const scope = userScope(leashBase, "device-alpha");
const customScope = userScope(leashBase, "device-beta", "/device-data");
const env = userEnv(leashBase, scope);
const seededConfig = JSON.parse(readFileSync(join(here, "..", "..", "..", "qvac.config.base.json"), "utf8")) as {
  cacheDirectory?: string;
  serve?: { models?: Record<string, { config?: { projectionModelSrc?: string } }> };
};

assert.equal(scope.scopeDir, "/base/Leash/device-alpha");
assert.equal(scope.dataDir, "/base/Leash/device-alpha/data");
assert.equal(scope.qvacHome, scope.dataDir, "qvac home should be the device data dir");
assert.equal(scope.modelsDir, join(scope.dataDir, "models"));
assert.equal(scope.dbPath, join(scope.dataDir, "db", "newsroom.db"));
assert.equal(scope.configPath, join(scope.dataDir, "qvac.config.mjs"));
assert.equal(scope.mcpReposDir, join(scope.dataDir, ".leash-mcp-repos"));
assert.equal(customScope.dataDir, "/device-data/device-beta");
assert.equal(customScope.modelsDir, "/device-data/device-beta/models");
assert.equal(customScope.dbPath, "/device-data/device-beta/db/newsroom.db");
assert.equal(customScope.configPath, "/device-data/device-beta/qvac.config.mjs");

assert.equal(env.HOME, scope.dataDir);
assert.equal(env.LEASH_DATA_DIR, scope.dataDir);
assert.equal(env.LEASH_DB_PATH, scope.dbPath);
assert.equal(env.DATABASE_URL, `file:${scope.dbPath}`);
assert.equal(env.QVAC_CONFIG_PATH, scope.configPath);
assert.equal(env.QVAC_MODELS_DIR, scope.modelsDir);
assert.equal(env.LEASH_MCP_REPOS_DIR, scope.mcpReposDir);
assert.equal(seededConfig.cacheDirectory, "~/models");
assert.equal(seededConfig.serve?.models?.["qwen3vl"]?.config?.projectionModelSrc?.startsWith("~/models/"), true);

console.log("verify-data-dir-env: ok");
