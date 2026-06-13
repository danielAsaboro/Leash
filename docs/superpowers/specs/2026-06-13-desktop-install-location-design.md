# Desktop install-location chooser — design (Phase 1)

**Date:** 2026-06-13
**App:** `apps/desktop` (Leash desktop — Electron shell around the `apps/web` dashboard)
**Status:** approved design → implementation plan next
**Scope:** Phase 1 only. Auth (single-user lock) is **Phase 2**, a separate spec.

---

## 1. Problem

The packaged Leash desktop app (a Next.js standalone server booted by the Electron
shell) writes all of its state to fixed locations: app data under the Electron
`userData` dir, the SQLite DB inside the seeded runtime, and multi-GB model weights
under `~/.qvac`. The user wants to **choose where everything lives on first run —
before anything downloads** — with a skip-to-default option. Benefits:

- Control where the multi-GB model cache lands (e.g. an external SSD).
- Clean **from-scratch testing**: point at a fresh folder, delete it to reset.

## 2. Goals / Non-goals

**Goals**
- A first-run native screen to pick **one base folder** for data + DB + model cache,
  or **Use default** (skip).
- Choice persists; later launches skip the screen.
- **Default/skip keeps everything under `userData` + `~/.qvac`** (same locations as
  today, with a tidier consolidated layout; model cache at `~/.qvac` is byte-identical).
- Backward compatible: the web app and packages still work unchanged outside the
  desktop shell (env-gated overrides only).

**Non-goals (Phase 1)**
- Auth / sign-in (Phase 2).
- Moving an existing install to a new location (no migration UI; choosing a new
  base just starts fresh there).
- Windows/Linux first-run polish (design is cross-platform but verified on macOS).

## 3. Architecture overview

A tiny **pointer file** (`install.json`) always lives in Electron's `userData`. It
records the chosen base (or `"default"`). Everything heavy lives under the base;
`userData` holds only the pointer. The shell derives all paths from the base and
**injects them as env vars** into the Next server process (and, transitively, into
the `qvac serve` the dashboard spawns). The web app reads those env vars with
**fallback to today's hardcoded defaults**, so nothing changes when they're absent.

```
userData/install.json   ──►  { base: "<abs path>" | "default", version: 1 }

base (custom)                       default (skip)
├── data/        LEASH_DATA_DIR      <userData>/data
├── db/newsroom.db  DATABASE_URL     <userData>/db/newsroom.db
├── runtime/     seeded standalone   <userData>/runtime
├── .qvac/       model cache (HOME)  ~/.qvac  (HOME unchanged)
└── qvac.config.* + QVAC_CONFIG_PATH (generated, absolute paths)
```

## 4. Components

### 4.1 First-run setup screen — Electron renderer
A small screen shown **before** the dashboard boots when `install.json` is absent.
- Copy: "Where should Leash keep its data and models?" + note that models are
  several GB and download on first use.
- Actions: **Use default** (writes `{base:"default"}`) and **Choose folder…**
  (native `dialog.showOpenDialog({properties:['openDirectory','createDirectory']})`).
- After choosing, shows the resolved paths (data / DB / models) and a **Start**
  button. Writes `install.json` via an IPC call, then proceeds to boot.
- Reuses the broadsheet splash styling already in the renderer.

**Interface:** preload exposes `install.get()`, `install.chooseFolder()`,
`install.save(base)`, `install.resolvedPaths(base)`; renderer is dumb UI.

### 4.2 Path bootstrap — Electron main (`src/main/install.ts`, new)
Pure-ish module, unit-testable:
- `readInstall(): InstallConfig | null` — read/validate `userData/install.json`.
- `resolvePaths(cfg): { base, dataDir, dbPath, runtimeDir, qvacHome, configPath }`
  — derive all paths; `"default"` → the `userData`/`~` locations above.
- `bootstrap(paths)` — `mkdir -p` the dirs; seed the standalone runtime
  (existing logic, retargeted to `paths.runtimeDir`); write a generated
  `qvac.config.mjs` + `qvac.config.base.json` with **absolute** paths under the base;
  initialize the DB if absent (§4.4).

### 4.3 Env injection — Electron main (`src/main/index.ts`)
When spawning the Next server, extend the env with:
- `LEASH_DATA_DIR=<dataDir>`
- `DATABASE_URL=file:<dbPath>`
- `QVAC_CONFIG_PATH=<configPath>`
- For a **custom** base only: `HOME=<base>` (so the SDK's `<HOME_DIR>/.qvac` cache
  resolves to `<base>/.qvac`). For **default**, leave `HOME` untouched → `~/.qvac`.

The dashboard's `serve-control` spawns `qvac serve` as a child that **inherits**
`process.env`, so `HOME`/`QVAC_CONFIG_PATH` flow through automatically. We verify
`serve-control` does not strip these (it currently spawns detached with the parent
env — a touch-point to confirm, not rewrite).

### 4.4 Web-app patches (minimal, env-gated, backward-compatible)
- `packages/db/src/index.ts`: DB path = `process.env.LEASH_DB_PATH` (or parse
  `DATABASE_URL`), else today's `join(PKG_ROOT, "prisma", "newsroom.db")`. The
  `datasourceUrl` is built from that.
- `apps/web/lib/leash/json-store.ts`: `DATA_DIR = process.env.LEASH_DATA_DIR ??`
  today's module-relative path.
- `apps/web/lib/leash/serve-control.ts`: confirm the spawned serve inherits
  `HOME`/`QVAC_CONFIG_PATH`; set cwd to a dir under the base (so config find-up
  resolves). No behavior change when the envs are unset.
- **DB initialization:** ship a **pre-migrated empty `newsroom.db` template** as a
  bundled resource; `bootstrap()` copies it to `dbPath` when absent. Avoids needing
  the Prisma CLI at runtime. (Built once via `prisma migrate deploy` against an empty
  file during `apps/web` build / a small script.)

## 5. Data flow (first launch, custom base)

1. Shell starts → `readInstall()` returns null → show setup screen.
2. User picks `/Volumes/SSD/Leash` → `install.save` writes `install.json`.
3. `resolvePaths` → `{ dataDir:/…/Leash/data, dbPath:/…/Leash/db/newsroom.db,
   runtimeDir:/…/Leash/runtime, qvacHome:/…/Leash, configPath:/…/Leash/qvac.config.mjs }`.
4. `bootstrap` mkdirs, seeds runtime, writes config, copies DB template.
5. Next server spawned with `LEASH_DATA_DIR`, `DATABASE_URL`, `QVAC_CONFIG_PATH`,
   `HOME=/…/Leash`.
6. Dashboard loads; user starts the serve from Brain → Models → it inherits the env
   → model weights download to `/Volumes/SSD/Leash/.qvac`.

Skip/default: steps 3–5 resolve to `<userData>/data`, `<userData>/db`, and `~/.qvac`
(`HOME` untouched) — same locations as today under a consolidated layout; the model
cache is byte-identical to today's `~/.qvac`.

## 6. Error handling
- Chosen folder not writable → setup screen shows an inline error, stays put.
- `install.json` corrupt/invalid → treat as absent (re-show setup); never crash.
- DB template missing from bundle → log + continue (Prisma will error lazily on
  db-backed routes; the UI still loads). Surfaced in the shell status line.
- Base folder deleted between launches → bootstrap re-creates dirs + DB template
  (pristine), data is gone by design.

## 7. Testing
- **Unit:** `resolvePaths` for `"default"` vs a custom base (path derivations);
  `readInstall` validation (valid / corrupt / absent).
- **Integration:** launch the packaged app with a temp base → assert
  `<base>/data`, `<base>/db/newsroom.db` created, `GET / → 200`, a db-backed API
  `→ 200`; delete base → relaunch → re-created pristine.
- **Default path:** skip → assert today's `userData`/`~/.qvac` behavior unchanged.
- **Backward compat:** `npm run web:dev` (no envs) still resolves the old paths.

## 8. Phase 2 (separate spec) — single-user lock
Out of scope here, noted for continuity: one owner sets a password on first run
(after the location step); the dashboard is gated behind a local login (Next
middleware + a hashed credential stored under `LEASH_DATA_DIR`); sign out re-locks.
Will be its own `…-desktop-auth-design.md`.

## 9. Files
- New: `apps/desktop/src/main/install.ts`, setup-screen renderer component(s),
  preload `install` API + d.ts, a `newsroom.db` template builder script,
  `apps/desktop/build`/extraResources entry for the template.
- Modify: `apps/desktop/src/main/index.ts` (bootstrap + env injection),
  `packages/db/src/index.ts`, `apps/web/lib/leash/json-store.ts`,
  `apps/web/lib/leash/serve-control.ts` (touch-point).
- Reference (unchanged): `qvac.config.mjs/.base.json` (template for the generated
  config), the SDK `getQvacPath` → `<HOME_DIR>/.qvac` resolution.
