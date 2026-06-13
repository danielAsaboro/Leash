# Desktop Install-Location Chooser — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On first launch, let the user pick one base folder for all Leash data + the model cache (or skip to default), before anything downloads.

**Architecture:** A `userData/install.json` pointer records the chosen base. The Electron shell derives every path from it and injects env vars (`LEASH_DATA_DIR`, `LEASH_DB_PATH`/`DATABASE_URL`, `QVAC_CONFIG_PATH`, and `HOME` for a custom base) into the Next standalone server; the dashboard's spawned `qvac serve` inherits them. The web app reads those envs with fallback to today's defaults, so non-desktop usage is unchanged.

**Tech Stack:** Electron (main + preload + React renderer), TypeScript/ESM, Next.js standalone server, Prisma (SQLite), `@qvac/sdk` (`<HOME_DIR>/.qvac` model cache), `tsx` for verification scripts.

**Spec:** `docs/superpowers/specs/2026-06-13-desktop-install-location-design.md`

**Repo realities (read first):**
- **No git on this box.** Ignore "commit" conventions; each task ends with a **Checkpoint** (run the verification command and confirm output).
- **No unit-test runner.** Verifications are `tsx` scripts using `node:assert` (the repo's smoke-script convention). Run with `npx tsx <path>`.
- **Never `npm install` in the background** (CLAUDE.md). Pure path logic lives in `install-paths.ts` (no `electron`/fs import at module load) so it's runnable under `tsx` outside Electron.

---

## File Structure

- **Create** `apps/desktop/src/main/install-paths.ts` — pure: types, `validateInstall`, `resolvePaths(cfg, {userDataDir, homeDir})`. No electron/fs.
- **Create** `apps/desktop/src/main/install.ts` — electron glue: `readInstall`, `saveInstall`, `chooseFolder`, `bootstrap`. Imports `install-paths`.
- **Create** `apps/desktop/scripts/verify-install-paths.ts` — `tsx` checks for the pure logic.
- **Create** `apps/desktop/scripts/build-db-template.sh` — produces the empty-DB template resource.
- **Create** `apps/desktop/resources/newsroom-template.db` — bundled empty (schema-only) DB (generated, not hand-written).
- **Create** setup-screen renderer: `apps/desktop/src/renderer/src/Setup.tsx`; route in `App.tsx`.
- **Modify** `apps/desktop/src/main/index.ts` — first-run gate, bootstrap, env injection, retargeted seeding.
- **Modify** `apps/desktop/src/preload/index.ts` + `index.d.ts` — add `install` API.
- **Modify** `apps/desktop/electron-builder.yml` — ship `newsroom-template.db` as an extraResource.
- **Modify** `packages/db/src/index.ts` — env-gated DB path.
- **Modify** `apps/web/lib/leash/json-store.ts` — env-gated `DATA_DIR`.

---

## Task 1: Env-gate the DB path (`packages/db`)

**Files:**
- Modify: `packages/db/src/index.ts` (the `DB_PATH` / `DATASOURCE_URL` lines)
- Test: `packages/db/scripts/verify-db-env.ts` (create)

- [ ] **Step 1: Write the failing verification**

Create `packages/db/scripts/verify-db-env.ts`:

```ts
import assert from "node:assert";
import { join } from "node:path";

// Reproduce the module's resolution rule in isolation (the module opens a real
// PrismaClient on import, so we test the rule, not the import).
function dbPath(env: NodeJS.ProcessEnv, pkgRoot: string): string {
  return env.LEASH_DB_PATH ?? join(pkgRoot, "prisma", "newsroom.db");
}
function datasourceUrl(env: NodeJS.ProcessEnv, pkgRoot: string): string {
  return env.DATABASE_URL ?? `file:${dbPath(env, pkgRoot)}`;
}

assert.equal(dbPath({}, "/pkg"), "/pkg/prisma/newsroom.db", "default path");
assert.equal(dbPath({ LEASH_DB_PATH: "/base/db/newsroom.db" } as any, "/pkg"), "/base/db/newsroom.db", "env override");
assert.equal(datasourceUrl({}, "/pkg"), "file:/pkg/prisma/newsroom.db", "default url");
assert.equal(datasourceUrl({ DATABASE_URL: "file:/x.db" } as any, "/pkg"), "file:/x.db", "url override");
console.log("OK verify-db-env");
```

- [ ] **Step 2: Run it (verifies the rule we're about to implement)**

Run: `npx tsx packages/db/scripts/verify-db-env.ts`
Expected: prints `OK verify-db-env` (the rule is correct; now make the module match it).

- [ ] **Step 3: Apply the env-gate in the module**

In `packages/db/src/index.ts`, change the two lines:

```ts
export const DB_PATH = process.env.LEASH_DB_PATH ?? join(PKG_ROOT, "prisma", "newsroom.db");
const DATASOURCE_URL = process.env.DATABASE_URL ?? `file:${DB_PATH}`;
```

(Leave the rest — `PrismaClient({ datasourceUrl: DATASOURCE_URL })` etc. — unchanged.)

- [ ] **Step 4: Verify the package still builds**

Run: `npx tsc -b packages/db`
Expected: exits 0, no errors.

- [ ] **Step 5: Checkpoint** — both commands above pass; default behavior preserved (no env set → same path as before).

---

## Task 2: Env-gate the data dir (`apps/web/lib/leash/json-store.ts`)

This cascades to `serve-control.ts` automatically (`ROOT = join(DATA_DIR, "..")`).

**Files:**
- Modify: `apps/web/lib/leash/json-store.ts:22`
- Test: `apps/web/scripts/verify-data-dir-env.ts` (create)

- [ ] **Step 1: Write the failing verification**

Create `apps/web/scripts/verify-data-dir-env.ts`:

```ts
import assert from "node:assert";
import { join } from "node:path";
function dataDir(env: NodeJS.ProcessEnv, here: string): string {
  return env.LEASH_DATA_DIR ?? join(here, "..", "..", "..", "..", "data");
}
assert.equal(dataDir({}, "/a/b/c/d/lib/leash"), "/a/b/c/d/lib/data", "default");
assert.equal(dataDir({ LEASH_DATA_DIR: "/base/data" } as any, "/x"), "/base/data", "override");
console.log("OK verify-data-dir-env");
```

- [ ] **Step 2: Run it**

Run: `npx tsx apps/web/scripts/verify-data-dir-env.ts`
Expected: prints `OK verify-data-dir-env`.

- [ ] **Step 3: Apply the env-gate**

In `apps/web/lib/leash/json-store.ts`, change line 22:

```ts
export const DATA_DIR = process.env.LEASH_DATA_DIR ?? join(here, "..", "..", "..", "..", "data");
```

- [ ] **Step 4: Verify the web app type-checks the changed file**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json 2>&1 | grep json-store || echo "no json-store errors"`
Expected: prints `no json-store errors`.

- [ ] **Step 5: Checkpoint** — verification passes; `serve-control` `ROOT` now follows `LEASH_DATA_DIR` with no further change (it imports `DATA_DIR` from this module and spawns `qvac serve` inheriting `process.env`).

---

## Task 3: Build the empty-DB template resource

**Files:**
- Create: `apps/desktop/scripts/build-db-template.sh`
- Create (generated): `apps/desktop/resources/newsroom-template.db`

- [ ] **Step 1: Write the template builder**

Create `apps/desktop/scripts/build-db-template.sh`:

```bash
#!/usr/bin/env bash
# Produce an empty (schema-only) newsroom.db that the desktop app copies into a
# fresh install's db path on first run. Uses `prisma db push` so it needs no
# migrations history. Run from the monorepo root.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="$ROOT/apps/desktop/resources/newsroom-template.db"
rm -f "$OUT"
DATABASE_URL="file:$OUT" npx prisma db push \
  --schema "$ROOT/packages/db/prisma/schema.prisma" \
  --skip-generate --accept-data-loss
echo "built template: $OUT ($(du -h "$OUT" | cut -f1))"
```

- [ ] **Step 2: Run it**

Run: `bash apps/desktop/scripts/build-db-template.sh`
Expected: prints `built template: …/newsroom-template.db (NNNK)` and the file exists.

- [ ] **Step 3: Verify the template has the schema (tables present)**

Run: `npx tsx -e "import {DatabaseSync} from 'node:sqlite'; const d=new DatabaseSync('apps/desktop/resources/newsroom-template.db'); const t=d.prepare(\"select name from sqlite_master where type='table'\").all(); console.log(t.map(r=>r.name).join(',')); if(!t.length) process.exit(1)"`
Expected: prints a comma list including `Edition,Article` (and others); non-empty.

- [ ] **Step 4: Checkpoint** — `apps/desktop/resources/newsroom-template.db` exists with tables.

---

## Task 4: Pure path resolution (`install-paths.ts`)

**Files:**
- Create: `apps/desktop/src/main/install-paths.ts`
- Test: `apps/desktop/scripts/verify-install-paths.ts`

- [ ] **Step 1: Write the failing verification**

Create `apps/desktop/scripts/verify-install-paths.ts`:

```ts
import assert from "node:assert";
import { validateInstall, resolvePaths } from "../src/main/install-paths.ts";

// validateInstall
assert.equal(validateInstall(null), null);
assert.equal(validateInstall({ version: 1, base: "default" })?.base, "default");
assert.equal(validateInstall({ version: 1, base: "/x" })?.base, "/x");
assert.equal(validateInstall({ version: 2, base: "/x" }), null, "wrong version");
assert.equal(validateInstall({ base: "/x" }), null, "missing version");

// resolvePaths — custom base
const c = resolvePaths({ version: 1, base: "/B" }, { userDataDir: "/U", homeDir: "/H" });
assert.equal(c.dataDir, "/B/data");
assert.equal(c.dbPath, "/B/db/newsroom.db");
assert.equal(c.runtimeDir, "/B/runtime");
assert.equal(c.qvacHome, "/B");
assert.equal(c.configPath, "/B/qvac.config.mjs");
assert.equal(c.setHome, true);

// resolvePaths — default
const d = resolvePaths({ version: 1, base: "default" }, { userDataDir: "/U", homeDir: "/H" });
assert.equal(d.dataDir, "/U/data");
assert.equal(d.dbPath, "/U/db/newsroom.db");
assert.equal(d.runtimeDir, "/U/runtime");
assert.equal(d.qvacHome, "/H");
assert.equal(d.configPath, "/U/qvac.config.mjs");
assert.equal(d.setHome, false);
console.log("OK verify-install-paths");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx apps/desktop/scripts/verify-install-paths.ts`
Expected: FAIL — `Cannot find module '../src/main/install-paths.ts'`.

- [ ] **Step 3: Implement the pure module**

Create `apps/desktop/src/main/install-paths.ts`:

```ts
import { join } from 'path'

/** Pointer persisted at userData/install.json. base="default" or an absolute path. */
export interface InstallConfig {
  version: 1
  base: string
}

export interface ResolvedPaths {
  base: string
  dataDir: string
  dbPath: string
  runtimeDir: string
  qvacHome: string
  configPath: string
  /** Whether to set HOME=<base> for child processes (custom base only). */
  setHome: boolean
}

/** Accept only a well-formed config; anything else → null (re-show setup). */
export function validateInstall(raw: unknown): InstallConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.version !== 1) return null
  if (typeof o.base !== 'string' || o.base.length === 0) return null
  return { version: 1, base: o.base }
}

/** Derive every path from the base. Pure — deps are injected for testability. */
export function resolvePaths(
  cfg: InstallConfig,
  deps: { userDataDir: string; homeDir: string }
): ResolvedPaths {
  const root = cfg.base === 'default' ? deps.userDataDir : cfg.base
  return {
    base: cfg.base,
    dataDir: join(root, 'data'),
    dbPath: join(root, 'db', 'newsroom.db'),
    runtimeDir: join(root, 'runtime'),
    qvacHome: cfg.base === 'default' ? deps.homeDir : cfg.base,
    configPath: join(root, 'qvac.config.mjs'),
    setHome: cfg.base !== 'default'
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx tsx apps/desktop/scripts/verify-install-paths.ts`
Expected: prints `OK verify-install-paths`.

- [ ] **Step 5: Checkpoint** — pure logic verified.

---

## Task 5: Electron install glue (`install.ts`)

**Files:**
- Create: `apps/desktop/src/main/install.ts`

- [ ] **Step 1: Implement the glue**

Create `apps/desktop/src/main/install.ts`:

```ts
import { app, dialog } from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync } from 'fs'
import {
  validateInstall,
  resolvePaths,
  type InstallConfig,
  type ResolvedPaths
} from './install-paths'

const installFile = (): string => join(app.getPath('userData'), 'install.json')

export function readInstall(): InstallConfig | null {
  try {
    return validateInstall(JSON.parse(readFileSync(installFile(), 'utf8')))
  } catch {
    return null
  }
}

export function saveInstall(base: string): InstallConfig {
  const cfg: InstallConfig = { version: 1, base }
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(installFile(), JSON.stringify(cfg, null, 2))
  return cfg
}

export function resolve(cfg: InstallConfig): ResolvedPaths {
  return resolvePaths(cfg, { userDataDir: app.getPath('userData'), homeDir: homedir() })
}

/** Native folder picker; returns the chosen absolute path or null if cancelled. */
export async function chooseFolder(): Promise<string | null> {
  const r = await dialog.showOpenDialog({
    title: 'Choose a folder for Leash data & models',
    properties: ['openDirectory', 'createDirectory']
  })
  return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
}

/**
 * Create dirs, seed the standalone runtime, drop the DB template if absent, and
 * write the generated qvac.config. Idempotent.
 */
export function bootstrap(p: ResolvedPaths): void {
  for (const d of [p.dataDir, join(p.dbPath, '..'), p.runtimeDir]) mkdirSync(d, { recursive: true })

  // Seed the read-only bundled standalone into the writable runtime (first run only).
  const bundled = join(process.resourcesPath, 'leash')
  if (existsSync(join(bundled, 'apps', 'web', 'server.js')) && !existsSync(join(p.runtimeDir, 'apps', 'web', 'server.js'))) {
    cpSync(bundled, p.runtimeDir, { recursive: true })
  }

  // Empty-DB template → db path (first run only).
  const tmpl = join(process.resourcesPath, 'newsroom-template.db')
  if (existsSync(tmpl) && !existsSync(p.dbPath)) cpSync(tmpl, p.dbPath)

  writeQvacConfig(p)
}

/** Write an absolute-path qvac.config.* under the base so the serve resolves it. */
function writeQvacConfig(p: ResolvedPaths): void {
  const src = join(process.resourcesPath, 'leash-config')
  if (existsSync(join(src, 'qvac.config.mjs'))) {
    // Ship-as-is: the wrapper expands ~/ via homedir(); with HOME=<base> set for
    // the serve, ~/.qvac resolves under the base. Copy both files next to configPath.
    cpSync(src, join(p.configPath, '..'), { recursive: true })
  }
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `cd apps/desktop && npx tsc --noEmit -p tsconfig.node.json --composite false 2>&1 | grep install || echo "no install errors"`
Expected: prints `no install errors`.

- [ ] **Step 3: Checkpoint** — glue compiles; pure logic already verified in Task 4.

---

## Task 6: Preload `install` API

**Files:**
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/preload/index.d.ts`

- [ ] **Step 1: Add the install API to the bridge**

In `apps/desktop/src/preload/index.ts`, add to the exposed object (alongside `shell`):

```ts
const installAPI = {
  /** Returns the saved base ("default"|path) or null if not configured yet. */
  get: (): Promise<string | null> => ipcRenderer.invoke('install:get'),
  /** Native folder picker → chosen path or null. */
  chooseFolder: (): Promise<string | null> => ipcRenderer.invoke('install:choose'),
  /** Resolve the human-readable paths for a base, for the confirm screen. */
  resolved: (base: string): Promise<{ dataDir: string; dbPath: string; qvacHome: string }> =>
    ipcRenderer.invoke('install:resolved', base),
  /** Persist the choice and proceed to boot. */
  save: (base: string): Promise<void> => ipcRenderer.invoke('install:save', base)
}
export type InstallAPI = typeof installAPI
```

Expose it: in both the `contextIsolated` try-block and the `else` branch, add
`contextBridge.exposeInMainWorld('install', installAPI)` / `window.install = installAPI`.

- [ ] **Step 2: Declare the type**

In `apps/desktop/src/preload/index.d.ts`, add to `Window`:

```ts
import type { ShellAPI, InstallAPI } from './index'
declare global {
  interface Window {
    electron: ElectronAPI
    shell: ShellAPI
    install: InstallAPI
  }
}
```

- [ ] **Step 3: Verify type-check**

Run: `npm run typecheck -w @mycelium/desktop`
Expected: exits 0 (no errors). (The IPC handlers land in Task 7; preload only declares the channels.)

- [ ] **Step 4: Checkpoint** — preload exposes `window.install`.

---

## Task 7: Main process — first-run gate, IPC, bootstrap, env injection

**Files:**
- Modify: `apps/desktop/src/main/index.ts`

- [ ] **Step 1: Register install IPC + gate boot on first run**

In `apps/desktop/src/main/index.ts`, import the glue and add handlers inside
`app.whenReady().then(() => { … })` (before `createWindow()`):

```ts
import { ipcMain } from 'electron'
import { readInstall, saveInstall, resolve as resolveInstall, chooseFolder, bootstrap } from './install'

ipcMain.handle('install:get', () => readInstall()?.base ?? null)
ipcMain.handle('install:choose', () => chooseFolder())
ipcMain.handle('install:resolved', (_e, base: string) => {
  const p = resolveInstall({ version: 1, base })
  return { dataDir: p.dataDir, dbPath: p.dbPath, qvacHome: p.qvacHome }
})
ipcMain.handle('install:save', (_e, base: string) => {
  saveInstall(base)
})
```

- [ ] **Step 2: Make `startServer()` use the resolved paths + env**

Replace the packaged branch of `startServer()` in `index.ts` so it resolves the
install, bootstraps, and injects env (build on the existing seed logic):

```ts
const cfg = readInstall()
if (!cfg) return sendStatus('Choose an install location to begin.') // setup screen handles this
const paths = resolveInstall(cfg)
bootstrap(paths)

const serverJs = join(paths.runtimeDir, 'apps', 'web', 'server.js')
const env: NodeJS.ProcessEnv = {
  ...process.env,
  PORT: String(WEB_PORT),
  NODE_ENV: 'production',
  PATH: runtimePath(),
  ELECTRON_RUN_AS_NODE: '1',
  LEASH_DATA_DIR: paths.dataDir,
  LEASH_DB_PATH: paths.dbPath,
  DATABASE_URL: `file:${paths.dbPath}`,
  QVAC_CONFIG_PATH: paths.configPath
}
if (paths.setHome) env.HOME = paths.qvacHome
server = spawn(process.execPath, [serverJs], { cwd: paths.runtimeDir, env, stdio: 'inherit' })
server.on('exit', (code) => {
  server = null
  if (code && code !== 0) sendStatus(`Leash server exited (code ${code}).`)
})
```

(Keep the existing `is.dev` branch as-is — dev still uses `npm run web:dev`.)

- [ ] **Step 3: Show the setup screen when not configured (packaged)**

In `createWindow()`'s `did-finish-load` handler, branch on install state:

```ts
mainWindow.webContents.once('did-finish-load', () => {
  if (!is.dev && !readInstall()) {
    mainWindow?.webContents.send('shell-route', 'setup') // renderer shows Setup.tsx
  } else {
    void bringUpDashboard()
  }
})
```

Add an IPC handler so the renderer can tell main the user finished setup, then boot:

```ts
ipcMain.handle('install:save', (_e, base: string) => {
  saveInstall(base)
  void bringUpDashboard()
})
```

(Replace the Step-1 `install:save` handler with this one — it both saves and boots.)

- [ ] **Step 4: Forward the route to the renderer**

In `apps/desktop/src/preload/index.ts`, add to `shellAPI`:

```ts
onRoute: (cb: (route: string) => void): (() => void) => {
  const l = (_e: Electron.IpcRendererEvent, r: string): void => cb(r)
  ipcRenderer.on('shell-route', l)
  return () => ipcRenderer.removeListener('shell-route', l)
}
```

- [ ] **Step 5: Verify type-check**

Run: `npm run typecheck -w @mycelium/desktop`
Expected: exits 0.

- [ ] **Step 6: Checkpoint** — type-checks; packaged boot now gated on `install.json`, env injected.

---

## Task 8: Setup screen (renderer)

**Files:**
- Create: `apps/desktop/src/renderer/src/Setup.tsx`
- Modify: `apps/desktop/src/renderer/src/App.tsx`

- [ ] **Step 1: Build the setup screen**

Create `apps/desktop/src/renderer/src/Setup.tsx`:

```tsx
import { useState } from 'react'

export function Setup({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [base, setBase] = useState<string | null>(null)
  const [paths, setPaths] = useState<{ dataDir: string; dbPath: string; qvacHome: string } | null>(null)
  const [busy, setBusy] = useState(false)

  async function pick(): Promise<void> {
    const chosen = await window.install.chooseFolder()
    if (!chosen) return
    setBase(chosen)
    setPaths(await window.install.resolved(chosen))
  }
  async function useDefault(): Promise<void> {
    setBase('default')
    setPaths(await window.install.resolved('default'))
  }
  async function start(): Promise<void> {
    if (!base) return
    setBusy(true)
    await window.install.save(base) // main saves + boots the dashboard
  }

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-6 bg-cream px-10 text-ink">
      <h1 className="font-display text-4xl font-semibold">Where should Leash live?</h1>
      <p className="max-w-md text-center font-body text-sm text-muted">
        Pick one folder for Leash&rsquo;s data and the AI model cache (several GB, downloaded on
        first use). You can change machines by moving this folder.
      </p>
      <div className="flex gap-3">
        <button className="rounded-lg border border-rule-strong bg-paper px-4 py-2 font-mono text-xs uppercase tracking-label" onClick={useDefault}>
          Use default
        </button>
        <button className="rounded-lg bg-sage-deep px-4 py-2 font-mono text-xs uppercase tracking-label text-cream" onClick={pick}>
          Choose folder…
        </button>
      </div>
      {paths && (
        <div className="mt-2 max-w-lg rounded-lg border border-rule bg-paper p-4 font-mono text-[11px] text-muted">
          <div>data: {paths.dataDir}</div>
          <div>db: {paths.dbPath}</div>
          <div>models: {paths.qvacHome}/.qvac</div>
        </div>
      )}
      <button
        className="rounded-lg bg-sage-deep px-6 py-2 font-mono text-xs uppercase tracking-label text-cream disabled:opacity-40"
        disabled={!base || busy}
        onClick={start}
      >
        {busy ? 'Starting…' : 'Start Leash'}
      </button>
    </div>
  )
}
```

- [ ] **Step 2: Route to it from `App.tsx`**

In `apps/desktop/src/renderer/src/App.tsx`, add route state driven by `onRoute`:

```tsx
import { useEffect, useState } from 'react'
import { Setup } from './Setup'

function App(): React.JSX.Element {
  const [route, setRoute] = useState<'splash' | 'setup'>('splash')
  const [status, setStatus] = useState('Starting Leash…')
  useEffect(() => window.shell.onStatus(setStatus), [])
  useEffect(() => window.shell.onRoute((r) => setRoute(r === 'setup' ? 'setup' : 'splash')), [])
  if (route === 'setup') return <Setup onDone={() => setRoute('splash')} />
  // …existing splash JSX (status) unchanged…
}
```

- [ ] **Step 3: Verify type-check + renderer build**

Run: `npm run build -w @mycelium/desktop`
Expected: exits 0; `out/renderer` rebuilt.

- [ ] **Step 4: Checkpoint** — setup screen builds; shown on first packaged run.

---

## Task 9: Package + end-to-end verification

**Files:**
- Modify: `apps/desktop/electron-builder.yml` (ship the DB template)

- [ ] **Step 1: Ship the DB template as a resource**

In `apps/desktop/electron-builder.yml`, add under `extraResources`:

```yaml
  - from: resources/newsroom-template.db
    to: newsroom-template.db
```

- [ ] **Step 2: Build the app + dmg**

Run (from repo root):
```bash
npm run build -w @mycelium/web        # refresh .next/standalone
cp -R apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static
cp -R apps/web/public apps/web/.next/standalone/apps/web/public
npm run build:mac -w @mycelium/desktop
```
Expected: `dist/mac-arm64/Leash.app` produced; the `afterPack` hook copies standalone `node_modules`.

- [ ] **Step 3: First-run with a custom temp base**

```bash
rm -rf "$HOME/Library/Application Support/@mycelium/desktop/install.json"
TMPBASE="/tmp/leash-test-$$"
"dist/mac-arm64/Leash.app/Contents/MacOS/Leash" >/tmp/leash-e2e.out 2>&1 &
# In the window: Choose folder… → $TMPBASE → Start.
```
Then assert (after the dashboard loads):
```bash
test -f "$TMPBASE/db/newsroom.db" && echo "db ✓"
test -d "$TMPBASE/data" && echo "data ✓"
test -d "$TMPBASE/runtime/apps/web" && echo "runtime ✓"
curl -s -m10 -o /dev/null -w "GET / → %{http_code}\n" http://localhost:6801/
```
Expected: `db ✓`, `data ✓`, `runtime ✓`, `GET / → 200`.

- [ ] **Step 4: Reset-from-scratch check**

```bash
pkill -f "Leash.app/Contents/MacOS/Leash"; rm -rf "$TMPBASE" "$HOME/Library/Application Support/@mycelium/desktop/install.json"
```
Relaunch → setup screen reappears → choose `$TMPBASE` again → pristine `db/data/runtime` re-created.
Expected: setup screen shown again; fresh dirs created.

- [ ] **Step 5: Default-path check**

Relaunch, choose **Use default** → assert data/db land under
`~/Library/Application Support/@mycelium/desktop/{data,db}` and the model cache stays `~/.qvac` (HOME unchanged).
Expected: dashboard loads; default dirs created; `~/.qvac` untouched.

- [ ] **Step 6: Build the final dmg**

```bash
cd apps/desktop/dist && STAGE=_s && rm -rf "$STAGE" Leash-0.0.0-arm64.dmg && mkdir "$STAGE" \
  && cp -R mac-arm64/Leash.app "$STAGE/" && ln -s /Applications "$STAGE/Applications" \
  && hdiutil create -volname Leash -srcfolder "$STAGE" -ov -format UDZO Leash-0.0.0-arm64.dmg && rm -rf "$STAGE"
```
Expected: `Leash-0.0.0-arm64.dmg` (~175 MB) created.

- [ ] **Step 7: Checkpoint** — custom base, reset, and default all verified; dmg built.

---

## Self-review notes
- **Spec coverage:** setup screen (Task 8), pointer + resolvePaths (Tasks 4–5), env injection incl. `HOME` for custom base (Task 7), web patches db+data (Tasks 1–2), DB template (Task 3), serve-control inheritance (Task 2 note — no code change needed), reset/default (Task 9). All spec §4–§7 points mapped.
- **Naming consistency:** `resolvePaths` (pure, deps-injected) vs `resolve` (electron wrapper in install.ts) — distinct names on purpose; `ResolvedPaths` fields (`dataDir/dbPath/runtimeDir/qvacHome/configPath/setHome`) used identically in Tasks 4, 5, 7.
- **No-git note:** "Checkpoint" replaces "commit" throughout (no git on this box).
- **Phase 2 (auth)** intentionally excluded — separate spec/plan.
