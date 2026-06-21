/**
 * Run the SDK helper scripts (model catalog + download) via the BUNDLED qvac runtime.
 *
 * On a packaged desktop install there is NO system Node/npx — the SDK lives in the downloaded
 * runtime (`LEASH_QVAC_CLI` → …/qvac-runtime/node_modules/@qvac/cli/dist/index.js). We launch the
 * helpers with `node --import <tsx-loader> <script>` instead of the tsx CLI:
 *   · the loader path avoids tsx CLI's IPC/bootstrap failure mode in detached/no-stdio contexts;
 *   · packaged helpers still need `@qvac/*` from the runtime tree AND `@mycelium/brain`, so we
 *     stage the script into `…/qvac-runtime/.leash-scripts/` and copy the Brain package into
 *     `…/qvac-runtime/node_modules/@mycelium/brain`.
 *
 * Dev (no LEASH_QVAC_CLI): use the current Node binary + `--import tsx/esm` from the workspace,
 * where both @qvac/* and @mycelium/* resolve normally from the repo root.
 */
import "server-only";
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { mkdirSync, copyFileSync, cpSync } from "node:fs";
import { dirname } from "node:path";
import { REPO_ROOT } from "@mycelium/leash-core/paths";
import { buildHelperScriptLaunch } from "./runtime-core.ts";

/** The downloaded qvac-runtime dir (…/qvac-runtime), derived from LEASH_QVAC_CLI. null in dev. */
export function bundledRuntimeDir(): string | null {
  const cli = process.env["LEASH_QVAC_CLI"]; // …/qvac-runtime/node_modules/@qvac/cli/dist/index.js
  if (!cli) return null;
  return dirname(dirname(dirname(dirname(dirname(cli))))); // up 5 → qvac-runtime
}

/**
 * Spawn a tsx helper script by filename (e.g. "leash-model-catalog.mts"). Returns the ChildProcess.
 * Packaged → bundled runtime (Electron-as-Node + tsx loader, script + Brain package staged into runtime).
 * Dev → current Node + `--import tsx/esm`.
 */
export function spawnHelperScript(
  scriptName: string,
  args: string[] = [],
  opts: { detached?: boolean; stdio?: StdioOptions } = {},
): ChildProcess {
  const detached = opts.detached ?? false;
  const stdio = opts.stdio ?? "ignore";
  const rt = bundledRuntimeDir();
  const spec = buildHelperScriptLaunch({
    rootDir: REPO_ROOT,
    runtimeSourceDir: process.env["LEASH_RUNTIME_SRC"] ?? null,
    runtimeDir: rt,
    nodeBin: process.env["LEASH_NODE_BIN"] ?? process.execPath,
    scriptName,
    args,
    env: process.env,
  });

  for (const copy of spec.copies) {
    mkdirSync(dirname(copy.to), { recursive: true });
    if (copy.recursive) {
      cpSync(copy.from, copy.to, { recursive: true, force: true });
    } else {
      copyFileSync(copy.from, copy.to);
    }
  }

  return spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    detached,
    stdio,
    env: spec.env,
  });
}
