import assert from "node:assert/strict";
import { join } from "node:path";
import { buildHelperScriptLaunch } from "../lib/leash/runtime-core.ts";

const devLaunch = buildHelperScriptLaunch({
  rootDir: "/repo/mycelium",
  runtimeSourceDir: null,
  runtimeDir: null,
  nodeBin: "/usr/local/bin/node",
  scriptName: "leash-model-download.mts",
  args: ["NOT_A_REAL_MODEL"],
  env: { NODE_ENV: "test", PATH: "/usr/local/bin" } as NodeJS.ProcessEnv,
});

assert.equal(devLaunch.command, "/usr/local/bin/node");
assert.deepEqual(devLaunch.args, [
  "--import",
  "tsx/esm",
  join("/repo/mycelium", "apps", "web", "scripts", "leash-model-download.mts"),
  "NOT_A_REAL_MODEL",
]);
assert.equal(devLaunch.cwd, "/repo/mycelium");
assert.equal(devLaunch.copies.length, 0);

const packagedLaunch = buildHelperScriptLaunch({
  rootDir: "/repo/mycelium",
  runtimeSourceDir: "/bundle/leash",
  runtimeDir: "/data/qvac-runtime",
  nodeBin: "/bundle/Electron",
  scriptName: "leash-model-download.mts",
  args: ["NOT_A_REAL_MODEL"],
  env: { NODE_ENV: "test", LEASH_BASE_DIR: "/Users/test/Leash" } as NodeJS.ProcessEnv,
});

assert.equal(packagedLaunch.command, "/bundle/Electron");
assert.deepEqual(packagedLaunch.args, [
  "--import",
  join("/data/qvac-runtime", "node_modules", "tsx", "dist", "esm", "index.mjs"),
  join("/data/qvac-runtime", ".leash-scripts", "leash-model-download.mts"),
  "NOT_A_REAL_MODEL",
]);
assert.equal(packagedLaunch.cwd, "/data/qvac-runtime");
assert.equal(packagedLaunch.env["ELECTRON_RUN_AS_NODE"], "1");
assert.deepEqual(packagedLaunch.copies, [
  {
    from: join("/bundle/leash", "apps", "web", "scripts", "leash-model-download.mts"),
    to: join("/data/qvac-runtime", ".leash-scripts", "leash-model-download.mts"),
    recursive: false,
  },
  {
    from: join("/bundle/leash", "packages", "brain"),
    to: join("/data/qvac-runtime", "node_modules", "@mycelium", "brain"),
    recursive: true,
  },
]);

console.log("verify-download-helper-runtime: ok");
