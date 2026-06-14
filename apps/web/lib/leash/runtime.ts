/**
 * Run the SDK helper scripts (model catalog + download) via the BUNDLED qvac runtime.
 *
 * On a packaged desktop install there is NO system Node/npx — the SDK lives in the downloaded
 * runtime (`LEASH_QVAC_CLI` → …/qvac-runtime/node_modules/@qvac/cli/dist/index.js). So instead of
 * `npx tsx <script>` (dev only), we run the script with Electron-as-Node + the runtime's bundled
 * tsx. Two things make it work:
 *   · ELECTRON_RUN_AS_NODE makes the Electron binary behave as Node — but then commander/tsx
 *     mis-parse argv (process.versions.electron set, process.defaultApp undefined → wrong slice),
 *     so a tiny ESM shim marks defaultApp before importing the real tsx cli.
 *   · NODE_PATH is IGNORED for ESM, so a bare `@qvac/*` import only resolves by walking up from the
 *     script's own location. We therefore COPY the script into the runtime tree
 *     (…/qvac-runtime/.leash-scripts/) so the walk finds …/qvac-runtime/node_modules/@qvac/*.
 *
 * Dev (no LEASH_QVAC_CLI): fall back to `npx tsx` from the workspace, where @qvac/* resolve normally.
 */
import "server-only";
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { DATA_DIR } from "./json-store.ts";

const ROOT = join(DATA_DIR, "..");

/** ESM shim: fix defaultApp (commander/tsx argv under ELECTRON_RUN_AS_NODE) then load the bundled tsx cli ($LEASH_RUN_ENTRY). */
const RUN_SHIM = `import { pathToFileURL } from "node:url";
try { Object.defineProperty(process, "defaultApp", { value: true, configurable: true }); } catch {}
await import(pathToFileURL(process.env.LEASH_RUN_ENTRY).href);
`;

/** The downloaded qvac-runtime dir (…/qvac-runtime), derived from LEASH_QVAC_CLI. null in dev. */
export function bundledRuntimeDir(): string | null {
  const cli = process.env["LEASH_QVAC_CLI"]; // …/qvac-runtime/node_modules/@qvac/cli/dist/index.js
  if (!cli) return null;
  return dirname(dirname(dirname(dirname(dirname(cli))))); // up 5 → qvac-runtime
}

/** Where the .mts helper scripts are staged: the bundled standalone (packaged) or the workspace (dev). */
function scriptsDir(): string {
  const src = process.env["LEASH_RUNTIME_SRC"]; // Resources/leash in the packaged app
  return src ? join(src, "apps", "web", "scripts") : join(ROOT, "apps", "web", "scripts");
}

/**
 * Spawn a tsx helper script by filename (e.g. "leash-model-catalog.mts"). Returns the ChildProcess.
 * Packaged → bundled runtime (Electron-as-Node + tsx, script copied into the runtime tree).
 * Dev → `npx tsx`.
 */
export function spawnHelperScript(
  scriptName: string,
  args: string[] = [],
  opts: { detached?: boolean; stdio?: StdioOptions } = {},
): ChildProcess {
  const detached = opts.detached ?? false;
  const stdio = opts.stdio ?? "ignore";
  const src = join(scriptsDir(), scriptName);
  const rt = bundledRuntimeDir();
  if (rt) {
    const nodeBin = process.env["LEASH_NODE_BIN"] ?? process.execPath;
    const tsxEntry = join(rt, "node_modules", "tsx", "dist", "cli.mjs");
    const dir = join(rt, ".leash-scripts");
    const shim = join(dir, "run-shim.mjs");
    const script = join(dir, scriptName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(shim, RUN_SHIM);
    copyFileSync(src, script); // into the runtime tree so ESM resolves @qvac/* via …/qvac-runtime/node_modules
    return spawn(nodeBin, [shim, script, ...args], {
      cwd: rt,
      detached,
      stdio,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", LEASH_RUN_ENTRY: tsxEntry },
    });
  }
  return spawn("npx", ["tsx", src, ...args], { cwd: ROOT, detached, stdio });
}
