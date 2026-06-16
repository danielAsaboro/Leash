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
