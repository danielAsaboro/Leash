# Leash desktop (`@mycelium/desktop`)

Cross-platform desktop LLM-chat client for **Leash** — the Mycelium exocortex's
local client. Built on Electron + React + Tailwind, with all inference running
**on-device through `@qvac/sdk`** (no cloud calls, ever — hackathon Rule 1).

"Leash" is the product/UI brand; "Mycelium" is the backend engine, hence the
`@mycelium/*` package scope.

## What it does (v1)

- Single-model local streaming chat, styled in the Mycelium "broadsheet" theme.
- Real model **download progress** on first run (`onProgress` → renderer).
- **Audit log** at `<userData>/logs/desktop.jsonl` — `model_load`, per-message
  `completion` records (TTFT, tok/s, tokens), and `model_unload` on quit — the
  hackathon's 3-stage verification evidence (CLAUDE.md § Audit-log requirement).

## Model & the `~/.qvac` cache

Weights are **not** bundled. On first run the configured model is downloaded into
the shared `~/.qvac` cache (symlinked to the external SSD on this mesh). After that
one warm-cache the app runs **fully offline** — fonts are bundled (`@fontsource`),
so airplane mode renders and chats identically (Rule 3).

Pick the model with an env var (default `qwen3-4b`, matching the mesh):

```bash
MYCELIUM_DESKTOP_MODEL=llama-1b npm run dev -w @mycelium/desktop
```

| key        | model              |
| ---------- | ------------------ |
| `qwen3-4b` | Qwen3 4B (default) |
| `llama-1b` | Llama 3.2 1B       |

## Develop

```bash
# from the monorepo root (one foreground install — never in background)
npm install
npm run dev -w @mycelium/desktop      # opens the Electron window
npm run typecheck -w @mycelium/desktop
```

## Package (Win / macOS / Linux)

```bash
npm run build:mac    -w @mycelium/desktop   # .dmg + .zip  → apps/desktop/dist/
npm run build:win    -w @mycelium/desktop   # nsis installer
npm run build:linux  -w @mycelium/desktop   # AppImage + deb
```

**Build each OS bundle on that OS** (or a CI matrix). `@qvac/sdk` ships
per-platform native binaries (`asarUnpack`'d so they survive packaging); there is
no reliable cross-compile. Model weights are downloaded at first run, not bundled.

### Why there is no `electron-builder install-app-deps` postinstall

The electron-vite scaffold normally adds an `install-app-deps` postinstall to
rebuild native modules against Electron's ABI. We **removed** it here on purpose:

- `@qvac/sdk` is hoisted to the **monorepo-root** `node_modules` and shared by the
  Node apps (`hub`, `hypha`, …). Rebuilding it against Electron's ABI in place
  would break those Node consumers.
- `@qvac/sdk`'s native code ships as runtime-selected **prebuilds**
  (`node-gyp-build` / prebuildify), not node-gyp builds — there is nothing for
  `install-app-deps` to rebuild for normal dev.

When you package, verify the bundled `@qvac/sdk` prebuilds match Electron's
`NODE_MODULE_VERSION` (Electron's ABI differs from Node's). If a prebuild for the
Electron runtime is missing, run a one-off `electron-builder install-app-deps`
**inside `apps/desktop` only** (never at the workspace root) before `build:<os>`.

## Shared seam (for a future `apps/mobile`)

The framework-agnostic chat model lives in `@mycelium/shared/chat`
(`ChatMessage`, `SHARED_CHAT_SYSTEM_PROMPT`, `buildHistory`). A future Expo app reuses
it verbatim; only the SDK-coupled model registry (`src/main/models.ts`) is
desktop-specific.
