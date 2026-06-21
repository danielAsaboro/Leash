import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapConfigFiles, seedBootstrapQvacConfig, seedScopedQvacConfig } from "../lib/leash/bootstrap-config.mjs";
import { ASSISTANT_KIT } from "../lib/leash/kit.ts";
import { leashBaseFrom, userScope } from "../lib/leash/scope.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const source = JSON.parse(readFileSync(join(here, "..", "..", "..", "qvac.config.base.json"), "utf8")) as {
  serve?: { models?: Record<string, unknown> };
};

const seeded = seedBootstrapQvacConfig(source);
const scope = userScope(leashBaseFrom("/base"), "device-alpha", "/device-data");
const files = bootstrapConfigFiles(scope);

assert.notEqual(seeded, source, "bootstrap seeding should clone the source config");
assert.ok(Object.keys(seeded.serve?.models ?? {}).length > 0, "fresh scopes should start with the recommended served aliases");
assert.deepEqual(seeded.serve?.models?.["chat"], source.serve?.models?.["chat"], "default chat alias should be preserved");
assert.deepEqual(seeded.serve?.models?.["embed"], source.serve?.models?.["embed"], "embedding alias should be preserved");
assert.deepEqual(
  Object.keys(seeded.serve?.models ?? {}).sort(),
  ASSISTANT_KIT.map((role) => role.alias).sort(),
  "seeded starter serve.models aliases must stay aligned with the onboarding recommended kit",
);
assert.equal(files.wrapper, "/device-data/device-alpha/qvac.config.mjs", "bootstrap wrapper should live at the scoped config path");
assert.equal(files.base, "/device-data/device-alpha/qvac.config.base.json", "bootstrap base config should live beside the scoped wrapper");

// Mutating the seeded copy must not mutate the source template.
const seededChat = seeded.serve?.models?.["chat"] as { default?: boolean } | undefined;
if (seededChat) seededChat.default = false;
assert.equal((source.serve?.models?.["chat"] as { default?: boolean } | undefined)?.default, true, "source template must stay immutable");

const tempRoot = mkdtempSync(join(tmpdir(), "leash-bootstrap-trace-"));
const srcDir = join(tempRoot, "src");
mkdirSync(srcDir, { recursive: true });
writeFileSync(join(srcDir, "qvac.config.mjs"), "export default { test: true };");
const traceScope = userScope(leashBaseFrom(join(tempRoot, "base")), "device-trace", join(tempRoot, "data"));
seedScopedQvacConfig({ scope: traceScope, sourceDir: srcDir, sourceConfig: source });
const tracedWrapper = readFileSync(join(tempRoot, "data", "device-trace", "qvac.config.mjs"), "utf8");
const tracedBase = JSON.parse(readFileSync(join(tempRoot, "data", "device-trace", "qvac.config.base.json"), "utf8")) as {
  serve?: { models?: Record<string, unknown> };
};
assert.ok(tracedWrapper.includes("test: true"), "scoped wrapper should be copied from the bootstrap source dir");
assert.ok(Object.keys(tracedBase.serve?.models ?? {}).length > 0, "scoped base config should retain the starter serve.models set");
assert.deepEqual(tracedBase.serve?.models?.["chat"], source.serve?.models?.["chat"], "scoped base config should carry the default chat alias");

console.log("bootstrap-model-config: ok");
