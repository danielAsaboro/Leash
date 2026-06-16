# Leash Marketing Site (`apps/landing`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a self-contained `mycelium/apps/landing` Next.js app — the existing landing page plus a new downloads page — that builds and deploys cleanly on Vercel, leaving the local-first `apps/web` untouched.

**Architecture:** Copy the landing's self-contained pieces (fonts, `globals.css`, `LeashMark`, `AppEmbed`, brand assets) into a fresh workspace with **zero `@mycelium/*` deps and no `undici`**, so the Vercel module-resolution errors are structurally impossible. The landing page is copied and edited (waitlist dropped, app links repointed); a new `/downloads` page renders 7 platform cards. Vercel's Root Directory is pointed at `apps/landing`.

**Tech Stack:** Next.js 15 (App Router), React 19, Tailwind CSS v4 (`@tailwindcss/postcss`), `next/font/local`, TypeScript. Static-first — no API routes.

**Spec:** `docs/superpowers/specs/2026-06-16-leash-landing-vercel-design.md`

**Reference source (copy from, do not modify):** `apps/web/`

---

## Verification model

This is a static marketing site; the "tests" are a clean production build plus guard greps that prove no forbidden server deps leaked in. Run all commands from `mycelium/apps/landing` unless stated otherwise.

---

### Task 1: Scaffold the `apps/landing` workspace skeleton

**Files:**
- Create: `apps/landing/package.json`
- Create: `apps/landing/next.config.mjs`
- Create: `apps/landing/postcss.config.mjs`
- Create: `apps/landing/tsconfig.json`
- Create: `apps/landing/next-env.d.ts`
- Create: `apps/landing/.gitignore`

- [ ] **Step 1: Create `apps/landing/package.json`**

```json
{
  "name": "@mycelium/landing",
  "version": "0.0.0",
  "private": true,
  "license": "Apache-2.0",
  "scripts": {
    "dev": "next dev -p 6810",
    "build": "next build",
    "start": "next start -p 6810"
  },
  "dependencies": {
    "next": "^15.5.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "^4.0.0",
    "@types/node": "20.17.6",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "tailwindcss": "^4.0.0",
    "typescript": "5.8.2"
  }
}
```

- [ ] **Step 2: Create `apps/landing/next.config.mjs`** (minimal — no `serverExternalPackages`, no bare-* webpack aliases; the landing has no server/bare deps)

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  // The marketing site is type-checked separately; don't let latent type drift gate the deploy.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
```

- [ ] **Step 3: Create `apps/landing/postcss.config.mjs`**

```js
export default {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
```

- [ ] **Step 4: Create `apps/landing/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "ES2022"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": {
      "@/*": ["./*"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 5: Create `apps/landing/next-env.d.ts`**

```ts
/// <reference types="next" />
/// <reference types="next/image-types/global" />

// NOTE: This file should not be edited
// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.
```

- [ ] **Step 6: Create `apps/landing/.gitignore`**

```
/node_modules
/.next
/out
*.tsbuildinfo
next-env.d.ts
```

- [ ] **Step 7: Install at the repo root** (npm workspaces; never in background per repo rule)

Run (from `mycelium/`): `npm install`
Expected: completes; `apps/landing/node_modules` is populated (or hoisted to root). No errors.

- [ ] **Step 8: Commit**

```bash
git add apps/landing/package.json apps/landing/next.config.mjs apps/landing/postcss.config.mjs apps/landing/tsconfig.json apps/landing/next-env.d.ts apps/landing/.gitignore package-lock.json
git commit -m "feat(landing): scaffold apps/landing workspace skeleton"
```

---

### Task 2: Copy the self-contained shared assets verbatim

These files have no `@mycelium/*` / server imports and are copied byte-for-byte. Only `LeashMark.tsx`'s import path changes (Task 3 edits it; copy it here).

**Files:**
- Create (copy): `apps/landing/app/fonts.ts`, `apps/landing/app/fonts/*`
- Create (copy): `apps/landing/app/globals.css`
- Create (copy): `apps/landing/components/LeashMark.tsx`
- Create (copy): `apps/landing/components/leash-mark.ts`
- Create (copy): `apps/landing/components/AppEmbed.tsx`
- Create (copy): `apps/landing/public/{landing,brand,*.png,*.ico}`

- [ ] **Step 1: Copy fonts + CSS + components + brand data** (run from `mycelium/`)

```bash
mkdir -p apps/landing/app apps/landing/components apps/landing/public
cp apps/web/app/fonts.ts                 apps/landing/app/fonts.ts
cp -R apps/web/app/fonts                  apps/landing/app/fonts
cp apps/web/app/globals.css               apps/landing/app/globals.css
cp apps/web/components/LeashMark.tsx       apps/landing/components/LeashMark.tsx
cp apps/web/lib/brand/leash-mark.ts        apps/landing/components/leash-mark.ts
cp apps/web/components/landing/AppEmbed.tsx apps/landing/components/AppEmbed.tsx
```

- [ ] **Step 2: Copy public assets the landing references** (screenshots, brand, favicons, app icons)

```bash
cp -R apps/web/public/landing  apps/landing/public/landing
cp -R apps/web/public/brand    apps/landing/public/brand
cp apps/web/public/favicon.ico          apps/landing/public/favicon.ico
cp apps/web/public/favicon-16x16.png    apps/landing/public/favicon-16x16.png
cp apps/web/public/favicon-32x32.png    apps/landing/public/favicon-32x32.png
cp apps/web/public/apple-touch-icon.png apps/landing/public/apple-touch-icon.png
cp apps/web/public/icon-192.png         apps/landing/public/icon-192.png
cp apps/web/public/icon-512.png         apps/landing/public/icon-512.png
```

- [ ] **Step 3: Verify the four landing screenshots and fonts arrived**

Run (from `mycelium/`): `ls apps/landing/public/landing && ls apps/landing/app/fonts/*.woff2 | wc -l`
Expected: `brain.png chat.png economy.png mesh.png` and `13`.

- [ ] **Step 4: Commit**

```bash
git add apps/landing/app/fonts.ts apps/landing/app/fonts apps/landing/app/globals.css apps/landing/components apps/landing/public
git commit -m "feat(landing): copy fonts, globals.css, brand components and public assets"
```

---

### Task 3: Fix `LeashMark` import path + slim root layout

`LeashMark.tsx` imports brand data from `../lib/brand/leash-mark.ts` (the app's layout). In `apps/landing` the data sits beside it at `./leash-mark.ts`.

**Files:**
- Modify: `apps/landing/components/LeashMark.tsx:1-7`
- Create: `apps/landing/app/layout.tsx`

- [ ] **Step 1: Repoint the brand-data import in `LeashMark.tsx`**

Change the import block at the top of `apps/landing/components/LeashMark.tsx` from:

```ts
} from "../lib/brand/leash-mark.ts";
```

to:

```ts
} from "./leash-mark.ts";
```

- [ ] **Step 2: Create the slim `apps/landing/app/layout.tsx`** (fonts + favicons only — no LeashRail/SearchPalette/OfflineHud/Toaster)

```tsx
import type { Metadata } from "next";
import { fraunces, newsreader, plexMono } from "./fonts.ts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Leash — your private, on-device assistant",
  description:
    "A private assistant grounded in your own data. No cloud. Powered by your personal device mesh — with a live economy of agents that pay each other for compute. QVAC Hackathon.",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/brand/leash-mark.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    shortcut: "/favicon.ico",
    apple: "/apple-touch-icon.png",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${newsreader.variable} ${plexMono.variable}`}>
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
```

- [ ] **Step 3: Verify `brand/leash-mark.svg` exists** (referenced by the favicon metadata)

Run (from `mycelium/`): `ls apps/landing/public/brand/leash-mark.svg`
Expected: the path prints. (If missing, the SVG favicon entry is cosmetic; the `.ico`/PNG icons still serve. Copy it from `apps/web/public/brand/` if present, otherwise drop that one `icon` line.)

- [ ] **Step 4: Commit**

```bash
git add apps/landing/components/LeashMark.tsx apps/landing/app/layout.tsx
git commit -m "feat(landing): slim root layout + local brand import path"
```

---

### Task 4: Create the landing page (copied + de-app'd)

Copy `apps/web/app/page.tsx` to `apps/landing/app/page.tsx`, then apply the edits below. The page keeps all broadsheet sections; only the waitlist and app-internal links change.

**Files:**
- Create (copy then edit): `apps/landing/app/page.tsx`

- [ ] **Step 1: Copy the page** (from `mycelium/`)

```bash
cp apps/web/app/page.tsx apps/landing/app/page.tsx
```

- [ ] **Step 2: Fix component import paths.** At the top of `apps/landing/app/page.tsx`, replace the three import lines:

```tsx
import { LeashMark } from "../components/LeashMark.tsx";
import { AppEmbed } from "../components/landing/AppEmbed.tsx";
import { WaitlistForm } from "../components/landing/WaitlistForm.tsx";
```

with (drop `WaitlistForm`, repoint `AppEmbed`):

```tsx
import { LeashMark } from "../components/LeashMark.tsx";
import { AppEmbed } from "../components/AppEmbed.tsx";
```

- [ ] **Step 3: Add an X URL constant.** Just below the existing `DOCS_URL` line, add:

```tsx
const X_URL = "https://x.com/useLeash";
```

- [ ] **Step 4: Repoint the nav.** In the `<nav className="landing-topnav">` block, replace:

```tsx
          <a href="#waitlist">Waitlist</a>
          <Link href="/chat" className="landing-topnav-cta">Open Leash →</Link>
```

with:

```tsx
          <a href="/downloads">Download</a>
          <Link href="/downloads" className="landing-topnav-cta">Download →</Link>
```

- [ ] **Step 5: Repoint the hero CTAs.** Replace the hero `landing-cta-row` block:

```tsx
        <div className="landing-cta-row rise" style={{ animationDelay: "0.84s" }}>
          <a href="#waitlist" className="landing-btn landing-btn-primary">
            Join the waitlist<span className="landing-btn-arrow" aria-hidden>→</span>
          </a>
          <Link href="/chat" className="landing-btn">
            Open Leash<span className="landing-btn-arrow" aria-hidden>→</span>
          </Link>
        </div>
```

with:

```tsx
        <div className="landing-cta-row rise" style={{ animationDelay: "0.84s" }}>
          <Link href="/downloads" className="landing-btn landing-btn-primary">
            Download Leash<span className="landing-btn-arrow" aria-hidden>→</span>
          </Link>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="landing-btn">
            Star on GitHub<span className="landing-btn-arrow" aria-hidden>→</span>
          </a>
        </div>
```

- [ ] **Step 6: Repoint the economy CTA.** Replace:

```tsx
          <Link href="/economy" className="landing-btn">
            See the economy<span className="landing-btn-arrow" aria-hidden>→</span>
          </Link>
```

with:

```tsx
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="landing-btn">
            See it on GitHub<span className="landing-btn-arrow" aria-hidden>→</span>
          </a>
```

- [ ] **Step 7: Replace the waitlist section with a "Get Leash" CTA.** Replace the entire block:

```tsx
      {/* Waitlist */}
      <section id="waitlist" className="landing-waitlist landing-reveal">
        <h2 className="landing-waitlist-head">Put your AI on a leash.</h2>
        <p className="landing-waitlist-dek">Private, on-device, yours. Join the waitlist and we’ll let you in.</p>
        <WaitlistForm />
      </section>
```

with:

```tsx
      {/* Get Leash */}
      <section id="get" className="landing-waitlist landing-reveal">
        <h2 className="landing-waitlist-head">Put your AI on a leash.</h2>
        <p className="landing-waitlist-dek">Private, on-device, yours. Download Leash for your platform.</p>
        <div className="landing-cta-row" style={{ justifyContent: "center" }}>
          <Link href="/downloads" className="landing-btn landing-btn-primary">
            Download Leash<span className="landing-btn-arrow" aria-hidden>→</span>
          </Link>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="landing-btn">
            Star on GitHub<span className="landing-btn-arrow" aria-hidden>→</span>
          </a>
          <a href={X_URL} target="_blank" rel="noopener noreferrer" className="landing-btn">
            Follow on X<span className="landing-btn-arrow" aria-hidden>→</span>
          </a>
        </div>
      </section>
```

- [ ] **Step 8: Repoint the footer nav.** Replace:

```tsx
          <Link href="/chat">Open Leash</Link>
          <a href="#waitlist">Waitlist</a>
```

with:

```tsx
          <Link href="/downloads">Download</Link>
          <a href={X_URL} target="_blank" rel="noopener noreferrer">X</a>
```

- [ ] **Step 9: Guard — confirm no waitlist/app-route leftovers remain.** Run (from `mycelium/`):

```bash
grep -nE "WaitlistForm|#waitlist|/chat|/economy|/mesh\"|/brain\"" apps/landing/app/page.tsx
```

Expected: no output. (The `AppEmbed` `route="/chat"` etc. props are fine — they pick a screenshot slug, not a link — so they will NOT match the patterns above, which only target `href`/`Link` usages and the dropped form.)

- [ ] **Step 10: Commit**

```bash
git add apps/landing/app/page.tsx
git commit -m "feat(landing): landing page with waitlist dropped, links repointed to downloads/GitHub/X"
```

---

### Task 5: Create the downloads page (`/downloads`)

**Files:**
- Create: `apps/landing/app/downloads/page.tsx`
- Modify: `apps/landing/app/globals.css` (append a small `.dl-*` style block)

- [ ] **Step 1: Append the downloads styles to `globals.css`.** Add to the end of `apps/landing/app/globals.css`:

```css

/* ── Downloads page ─────────────────────────────────────────────── */
.dl-intro {
  max-width: 60ch;
  margin: 0 auto 2.5rem;
  text-align: center;
  font-family: var(--font-newsreader), Georgia, serif;
  color: var(--color-ink-soft, var(--color-ink));
}
.dl-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 1px;
  background: var(--color-rule, currentColor);
  border: 1px solid var(--color-rule, currentColor);
}
.dl-card {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 1.5rem 1.25rem;
  background: var(--color-paper, var(--color-cream));
  min-height: 160px;
}
.dl-card-name {
  font-family: var(--font-fraunces), Georgia, serif;
  font-weight: 600;
  font-size: 1.25rem;
}
.dl-card-note {
  font-family: var(--font-plex), ui-monospace, monospace;
  font-size: 0.72rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-ink-soft, var(--color-ink));
}
.dl-card-action { margin-top: auto; }
.dl-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-family: var(--font-plex), ui-monospace, monospace;
  font-size: 0.8rem;
  text-decoration: none;
  border: 1px solid var(--color-ink);
  padding: 0.4rem 0.75rem;
  color: var(--color-ink);
}
.dl-btn:hover { background: var(--color-ink); color: var(--color-paper, var(--color-cream)); }
.dl-soon {
  font-family: var(--font-plex), ui-monospace, monospace;
  font-size: 0.72rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  opacity: 0.5;
}
```

- [ ] **Step 2: Create `apps/landing/app/downloads/page.tsx`**

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { LeashMark } from "../../components/LeashMark.tsx";

export const metadata: Metadata = {
  title: "Download Leash — every platform",
  description:
    "Get Leash for macOS, Windows, Linux, Android, iOS, iPadOS, or open it in your browser. Private, on-device, yours.",
};

const GITHUB_URL = "https://github.com/danielAsaboro/Leash";
const RELEASES_URL = "https://github.com/danielAsaboro/Leash/releases/latest";
const X_URL = "https://x.com/useLeash";

/**
 * One entry per platform. `href` null → a dimmed "Coming soon" card. To ship a real
 * installer later, set `href` to the GitHub Release asset / store URL. `web` opens the
 * user's own locally-running Leash (local-first: there is no cloud-hosted app).
 */
type Platform = { name: string; note: string; href: string | null; cta: string };

const PLATFORMS: Platform[] = [
  { name: "macOS", note: ".dmg · Apple Silicon & Intel", href: RELEASES_URL, cta: "Get from Releases" },
  { name: "Windows", note: ".exe installer", href: null, cta: "" },
  { name: "Linux", note: ".AppImage · .deb", href: null, cta: "" },
  { name: "Android", note: "Play Store · .apk", href: null, cta: "" },
  { name: "iOS", note: "App Store · TestFlight", href: null, cta: "" },
  { name: "iPadOS", note: "App Store · TestFlight", href: null, cta: "" },
  { name: "Web", note: "Open your running instance", href: "http://localhost:6801", cta: "Open localhost:6801" },
];

export default function Downloads() {
  return (
    <div className="landing">
      {/* Masthead nav */}
      <header className="landing-topbar">
        <Link href="/" className="landing-brand" aria-label="Leash">
          <LeashMark className="landing-brand-mark" cutoutColor="var(--color-ink)" />
          <span className="landing-brand-word">Leash</span>
        </Link>
        <nav className="landing-topnav">
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">GitHub</a>
          <a href={X_URL} target="_blank" rel="noopener noreferrer">X</a>
          <Link href="/" className="landing-topnav-cta">Home →</Link>
        </nav>
      </header>

      <div className="landing-rule-thick" />
      <div className="landing-masthead">
        <span className="landing-masthead-side">Get Leash</span>
        <h1 className="landing-wordmark" aria-label="Download">DOWNLOAD</h1>
        <span className="landing-masthead-side landing-masthead-side-r">On-device · Private</span>
      </div>
      <div className="landing-rule-thin" />

      <section className="landing-reveal" style={{ padding: "2.5rem 1.5rem" }}>
        <p className="dl-intro">
          Leash runs entirely on your own hardware. Desktop installers come from{" "}
          <a href={RELEASES_URL} target="_blank" rel="noopener noreferrer">GitHub Releases</a>;
          mobile ships through the app stores. The Web option opens Leash in your browser against
          the instance running on your own machine — there is no cloud version, by design.
        </p>

        <div className="dl-grid">
          {PLATFORMS.map((p) => (
            <div key={p.name} className="dl-card">
              <span className="dl-card-name">{p.name}</span>
              <span className="dl-card-note">{p.note}</span>
              <div className="dl-card-action">
                {p.href ? (
                  <a className="dl-btn" href={p.href} target="_blank" rel="noopener noreferrer">
                    {p.cta} <span aria-hidden>→</span>
                  </a>
                ) : (
                  <span className="dl-soon">Coming soon</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="landing-rule-thick" />
      <footer className="landing-footer">
        <span className="landing-footer-mark">LEASH</span>
        <nav className="landing-footer-nav">
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">GitHub</a>
          <a href={X_URL} target="_blank" rel="noopener noreferrer">X</a>
          <Link href="/">Home</Link>
        </nav>
        <span className="landing-footer-meta">Apache-2.0 · QVAC Hackathon · useleash.xyz</span>
      </footer>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/landing/app/downloads/page.tsx apps/landing/app/globals.css
git commit -m "feat(landing): downloads page with 7 platform cards"
```

---

### Task 6: Build verification + forbidden-import guard

**Files:** none (verification only)

- [ ] **Step 1: Guard — no forbidden imports anywhere under `apps/landing`.** Run (from `mycelium/`):

```bash
grep -rnE "@mycelium/|undici|server-only|@qvac/|@prisma|bare-" apps/landing --include=*.ts --include=*.tsx
```

Expected: no output. (If anything prints, a non-self-contained file was copied in — remove that import before continuing.)

- [ ] **Step 2: Production build.** Run (from `mycelium/apps/landing`):

```bash
npm run build
```

Expected: `✓ Compiled successfully`, route list includes `○ /` and `○ /downloads`, **no** "Module not found" errors. (Contrast: the `apps/web` build failed here on `@mycelium/db`/`undici`.)

- [ ] **Step 3: Smoke-test locally.** Run (from `mycelium/apps/landing`): `npm run start` then in another shell:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:6810/
curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:6810/downloads
```

Expected: `200` and `200`. Stop the server after.

- [ ] **Step 4: Commit** (no-op if Steps 1–3 produced no file changes; otherwise commit any fixes)

```bash
git commit -am "test(landing): verify clean build + no forbidden imports" --allow-empty
```

---

### Task 7: Point Vercel at `apps/landing` (manual dashboard config — documented)

**Files:**
- Create: `apps/landing/README.md` (records the exact Vercel settings so the config is reproducible)

> These are dashboard/CLI actions on the existing Vercel project (the one currently failing on `apps/web`). They are documented here and in the README; the implementing agent applies them in the Vercel UI (or hands them to the user).

- [ ] **Step 1: Create `apps/landing/README.md`**

````markdown
# @mycelium/landing — Leash marketing site

The public marketing surface (landing + downloads) deployed to Vercel at `useleash.xyz`.
**Self-contained**: zero `@mycelium/*` deps, no QVAC/DB/server code — so it builds and runs on
stateless Vercel. The real, local-first app is `apps/web` and is **not** deployed here.

## Local

```bash
npm run dev    # http://localhost:6810
npm run build  # production build
```

## Vercel settings (existing project)

- **Root Directory:** `apps/landing`
- **Framework Preset:** Next.js
- **Build Command:** `next build` (default)
- **Install Command:** default (npm workspaces install from repo root)
- **Domain:** `useleash.xyz` → this project

Fallback if the repo-root `postinstall` (`prisma generate`) ever breaks the landing build:
set Install Command to `cd apps/landing && npm install` and Build Command to
`cd apps/landing && npm run build`.

## Adding a real installer

Edit the `PLATFORMS` array in `app/downloads/page.tsx`: set a platform's `href` to its GitHub
Release asset or store URL and give it a `cta` label. A `null` `href` renders "Coming soon".
````

- [ ] **Step 2: Apply Vercel project settings** — in the Vercel dashboard for the project, set **Settings → General → Root Directory = `apps/landing`**, confirm Framework = Next.js, leave Build/Install at defaults. (Or via CLI: `vercel link` to the project, then set Root Directory in the dashboard — root dir is not a `vercel.json` field.)

- [ ] **Step 3: Trigger a deploy** — push the branch / `vercel --prod`, or click Redeploy. Expected: build succeeds (no `@mycelium/db`/`undici` errors), preview/prod URL serves `/` and `/downloads`.

- [ ] **Step 4: Commit**

```bash
git add apps/landing/README.md
git commit -m "docs(landing): record Vercel deploy config"
```

---

## Self-review notes

- **Spec coverage:** scaffold (T1), self-contained copies/no-workspace-dep (T2/T6 guard), slim layout (T3), landing edits — waitlist dropped + links repointed (T4), downloads page with 7 cards incl. Web→localhost:6801 (T5), Vercel Root Directory config (T7). All spec sections mapped.
- **`apps/web` untouched:** every `cp` reads from `apps/web` and writes to `apps/landing`; no task modifies `apps/web`. Acceptance "byte-for-byte unchanged" holds.
- **X handle / repo:** `https://x.com/useLeash`, `https://github.com/danielAsaboro/Leash` — used consistently in T4 and T5.
- **No placeholders:** every code/edit step shows exact content; the only "Coming soon" states are the intended product states (null `href`), not plan gaps.
- **Naming consistency:** `PLATFORMS`/`Platform`/`href`/`cta` consistent across T5; `landing-*` classes reused from copied `globals.css`; new `.dl-*` classes defined in T5 Step 1 before use in T5 Step 2.
