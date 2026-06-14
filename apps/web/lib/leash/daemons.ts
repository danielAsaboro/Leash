/**
 * Launch the dashboard-managed daemons (hypha, watcher, newsroom, leash-cron, leash-broker,
 * leash-mcp, …) in the PACKAGED app. The daemon source + their @mycelium packages + extra deps
 * ship as an on-demand "leash-daemons" overlay that the Electron main downloads into
 * `<qvac-runtime>/leash-daemons/` (see deps.ts ensureDaemons). The daemons resolve `@qvac/sdk` +
 * `tsx` from the runtime one dir up, and their own deps from the overlay's node_modules.
 *
 * Run via Electron-as-Node + the runtime's tsx through the same defaultApp shim as the serve/catalog
 * (commander/tsx mis-parse argv under ELECTRON_RUN_AS_NODE otherwise). Dev has no overlay — callers
 * fall back to `npx tsx` from the monorepo (services.ts CODE_ROOT).
 */
import "server-only";
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bundledRuntimeDir } from "./runtime.ts";

/** The on-demand daemon overlay root (…/qvac-runtime/leash-daemons), or null in dev / no runtime. */
export function daemonsRoot(): string | null {
  const rt = bundledRuntimeDir();
  return rt ? join(rt, "leash-daemons") : null;
}

/** Has the overlay been downloaded + extracted (the main downloads it in the background)? */
export function daemonsReady(): boolean {
  const root = daemonsRoot();
  return !!root && existsSync(join(root, "apps", "hypha", "src", "main.ts"));
}

const RUN_SHIM = `import { pathToFileURL } from "node:url";
try { Object.defineProperty(process, "defaultApp", { value: true, configurable: true }); } catch {}
await import(pathToFileURL(process.env.LEASH_RUN_ENTRY).href);
`;

/** Spawn a daemon entry (e.g. "apps/hypha/src/main.ts") from the overlay via the bundled runtime. */
export function spawnDaemon(
  entryRel: string,
  opts: { detached?: boolean; stdio?: StdioOptions; env?: NodeJS.ProcessEnv } = {},
): ChildProcess {
  const rt = bundledRuntimeDir();
  const root = daemonsRoot();
  if (!rt || !root) throw new Error("daemon overlay not available");
  const nodeBin = process.env["LEASH_NODE_BIN"] ?? process.execPath;
  const tsxEntry = join(rt, "node_modules", "tsx", "dist", "cli.mjs");
  const shim = join(root, "run-shim.mjs");
  writeFileSync(shim, RUN_SHIM);
  return spawn(nodeBin, [shim, entryRel], {
    cwd: root,
    detached: opts.detached ?? true,
    stdio: opts.stdio ?? "ignore",
    env: { ...(opts.env ?? process.env), ELECTRON_RUN_AS_NODE: "1", LEASH_RUN_ENTRY: tsxEntry },
  });
}
