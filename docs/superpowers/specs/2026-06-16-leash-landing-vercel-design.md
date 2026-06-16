# Leash marketing site (`apps/landing`) on Vercel — design

**Date:** 2026-06-16
**Status:** Approved (brainstorm) → ready for implementation plan
**Owner:** daniel

## Problem

The Vercel project (`github.com/danielAsaboro/Leash`) is configured to build `apps/web`,
which is the **entire local-first Leash app** (chat, brain, economy, mesh, 30+ API routes).
The build fails:

```
./lib/db.ts            Module not found: Can't resolve '@mycelium/db'
./lib/leash/provider.ts Module not found: Can't resolve 'undici'
./lib/leash/tools.ts   Module not found: Can't resolve '@mycelium/db'
./lib/queries.ts       Module not found: Can't resolve '@mycelium/db'
```

`@mycelium/db`'s `dist/` isn't built on a fresh Vercel clone, and `undici` is imported but
undeclared. **But fixing these is the wrong goal:** `apps/web` is local-first by design — it
requires the QVAC SDK, on-device GGUF models, a local Prisma DB, and the device mesh. It cannot
*run* on stateless Vercel serverless even if it compiled. Per repo Hard Rules (offline,
on-device, no cloud), the real app stays local.

## Goal

Ship **only** a public marketing surface to Vercel: the existing **landing page** plus a new
**downloads page**. The full app is untouched and stays local.

## Decisions (locked during brainstorm)

1. **Location:** new self-contained `mycelium/apps/landing` workspace (not a separate repo).
2. **Downloads:** GitHub Releases (mac/win/linux) + app stores (iOS/iPadOS/Android), with a
   **"Coming soon"** state for anything not yet built. Real URLs are dropped in per-platform later.
3. **Waitlist:** dropped. CTAs point to GitHub + X instead.
4. **X handle:** `https://x.com/useLeash`. **Repo:** `https://github.com/danielAsaboro/Leash`.
5. **Web platform card:** opens the locally-running Leash at `http://localhost:6801` (honest
   local-first story — there is no cloud-hosted app), clearly labelled so it doesn't read as broken.

## Architecture

A new Next.js 15 app at `mycelium/apps/landing`, **fully self-contained** — **zero `@mycelium/*`
workspace dependencies and no `undici`**, so it structurally cannot hit the current resolution
errors. Static-first: no API routes that need a backend. Deploys and runs cleanly on Vercel.

```
apps/landing/
  app/
    layout.tsx          # slim: fonts + favicons only (NO LeashRail/SearchPalette/OfflineHud/Toaster)
    page.tsx            # landing — copied from apps/web/app/page.tsx, modified (see below)
    downloads/page.tsx  # NEW
    fonts.ts            # copied verbatim from apps/web/app/fonts.ts
    fonts/              # copied: 13 .woff2 + OFL.txt
    globals.css         # copied verbatim from apps/web/app/globals.css (dead app rules are harmless)
  components/
    LeashMark.tsx       # copied; import path → ./leash-mark.ts
    AppEmbed.tsx        # copied verbatim (renders a screenshot <img>; no navigation)
    leash-mark.ts       # copied from apps/web/lib/brand/leash-mark.ts
  public/
    landing/{chat,mesh,brain,economy}.png
    brand/  favicon.ico  favicon-16x16.png  favicon-32x32.png
    apple-touch-icon.png  icon-192.png  icon-512.png
  package.json          # deps: next, react, react-dom; dev: tailwindcss, @tailwindcss/postcss, typescript, @types/*
  next.config.mjs       # minimal (NO serverExternalPackages / bare-* webpack aliases needed)
  postcss.config.mjs    # { plugins: { "@tailwindcss/postcss": {} } }
  tsconfig.json         # copied from apps/web (allowImportingTsExtensions, paths @/*)
```

**Why copy `globals.css` verbatim rather than extract the `.landing-*` subset:** the file is
2461 lines of Tailwind v4 `@theme` tokens + base typography + 132 landing rules tangled with app
UI. Copying wholesale guarantees pixel fidelity; unused app rules are dead bytes, not bugs. We can
prune later if size matters.

**Why a slim `layout.tsx`:** the app's layout mounts `LeashRail`, `SearchPalette`, `OfflineHud`,
`Toaster` — all app-only, some pulling client deps we don't want. The landing layout needs only
the three font variables on `<html>` and the favicon metadata.

## Component-level changes to `page.tsx`

Copied from `apps/web/app/page.tsx`, then:

- **Remove** `import { WaitlistForm }` and the entire `#waitlist` `<section>`. Replace that
  section with a **"Get Leash"** CTA block (keep the headline "Put your AI on a leash."):
  buttons `[Download Leash → /downloads]`, `[Star on GitHub → repo]`, `[Follow on X → x.com/useLeash]`.
- **Repoint app links** (there is no app on the marketing domain):
  - nav CTA "Open Leash → `/chat`" → "Download → `/downloads`"
  - hero secondary "Open Leash → `/chat`" → "Star on GitHub → repo"
  - economy "See the economy → `/economy`" → GitHub repo
  - footer "Open Leash → `/chat`" → "Download → `/downloads`"
- **Nav item** "Waitlist" (`#waitlist`) → "Download" (`/downloads`).
- `LeashMark`/`AppEmbed` imports repoint to the local `components/` copies.
- `DOCS_URL` stays as `https://docs.useleash.xyz` (existing placeholder).

`AppEmbed` is unchanged: it reads `/landing/<slug>.png` and renders a captioned `<img>` with an
`onError` placeholder. The four PNGs are copied, so all four figures render.

## Downloads page (`/downloads`)

Same broadsheet styling (reuses `globals.css` tokens/classes; add a small `.downloads-*` block to
the copied CSS or inline). A `PLATFORMS` array drives the cards:

```ts
type Platform = { name: string; icon: ReactNode; href: string | null; note: string };
// href null  → dimmed "Coming soon" card
// href set   → active download/open button
```

| Platform | `href` (now) | Rendered state |
|---|---|---|
| macOS   | repo `/releases/latest` | "Coming soon" badge + link to Releases until a `.dmg` exists |
| Windows | `null` | Coming soon |
| Linux   | `null` | Coming soon |
| Android | `null` | Coming soon |
| iOS     | `null` | Coming soon |
| iPadOS  | `null` | Coming soon |
| Web     | `http://localhost:6801` | "Open Leash in your browser" — opens your locally-running instance |

Page also carries the masthead/nav/footer for consistency and a one-line explainer that Leash is
local-first (installers come from GitHub Releases; the Web card opens your own running instance).
Optional nice-to-have if cheap: client-side OS detection to highlight the visitor's platform card.

Adding a real installer later = setting one `href` in the `PLATFORMS` array.

## Deployment (Vercel)

Reconfigure the **existing** project (no new repo, no new connection):

- **Root Directory** → `apps/landing`
- **Framework Preset** → Next.js; **Build Command** → `next build` (default)
- **Install** stays at repo root (npm workspaces). The root `postinstall` (`prisma generate`)
  already succeeds in current logs and `apps/landing` imports nothing from it, so it's harmless.
- **Domain:** `useleash.xyz` → this project.
- **Fallback** (only if the root `postinstall` ever breaks the landing build): override the
  Vercel **Install Command** to `cd apps/landing && npm install` and the **Build Command** to
  `cd apps/landing && npm run build`, so the landing builds in isolation from the monorepo root.
  Not needed today (root install is green); documented in case it regresses.

## Out of scope (YAGNI)

- Fixing `apps/web`'s `@mycelium/db` / `undici` errors. `apps/web` is **not** deployed to Vercel.
- Any waitlist backend or storage.
- Producing real platform binaries — this work ships the page structure only.
- A cloud-hosted version of the app.

## Acceptance

- `cd apps/landing && next build` succeeds with no module-resolution errors.
- Vercel deploy of `apps/landing` is green; `/` renders the landing pixel-faithful to the local
  one (fonts, broadsheet rules, four screenshots), `/downloads` renders 7 platform cards.
- No `@mycelium/*` or `undici` import anywhere under `apps/landing`.
- `apps/web` is byte-for-byte unchanged.
