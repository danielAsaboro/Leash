/**
 * Post-build staging for the Next standalone bundle (what the desktop ships as `leash`):
 *
 *  1. Copy `.next/static` and `public/` INTO the standalone — `output: standalone` does NOT
 *     include them, and without them every `/_next/static/*` asset 404s → ChunkLoadError →
 *     "client-side exception" in the packaged app. (Dev/`next start` serve them from the repo,
 *     which is why this only bites the bundled desktop app.)
 *  2. Copy the supervisor (`server-launch.mjs` + `lib/leash/scope.mjs`) in, so it rides inside
 *     `leash` (electron-builder copies the standalone dir reliably; single-file extraResources
 *     from another workspace are flaky). The desktop runs `leash/apps/web/server-launch.mjs`.
 */
import { cpSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // apps/web/scripts
const web = join(here, "..");
const repoRoot = join(web, "..", "..");
const standalone = join(web, ".next", "standalone");
const dst = join(standalone, "apps", "web"); // monorepo standalone layout

if (!existsSync(join(dst, "server.js"))) {
  console.warn("[stage-launcher] standalone not found — run `next build` first");
  process.exit(0);
}

// 1. static assets (required for the client to load) + public/
cpSync(join(web, ".next", "static"), join(dst, ".next", "static"), { recursive: true });
if (existsSync(join(web, "public"))) cpSync(join(web, "public"), join(dst, "public"), { recursive: true });

// 2. the supervisor
mkdirSync(join(dst, "lib", "leash"), { recursive: true });
cpSync(join(web, "server-launch.mjs"), join(dst, "server-launch.mjs"));
cpSync(join(web, "lib", "leash", "scope.mjs"), join(dst, "lib", "leash", "scope.mjs"));

// 3. the SDK helper scripts (model catalog + download) — Next standalone only traces IMPORTED
//    files, and these are SPAWNED (never imported), so they'd be absent. The API routes run them
//    via the bundled qvac runtime (see lib/leash/runtime.ts). Without this the Models list is
//    empty on a fresh install and downloads can't start.
mkdirSync(join(dst, "scripts"), { recursive: true });
for (const s of ["leash-model-catalog.mts", "leash-model-download.mts"]) {
  cpSync(join(web, "scripts", s), join(dst, "scripts", s));
}

// 4. the shared Brain package — the helper scripts need both the built-in data AND the compiled
//    package entrypoints. Next standalone never traces this package for the spawned helpers, so
//    stage it explicitly for packaged desktop/runtime helper launches.
const brainSrc = join(repoRoot, "packages", "brain");
const brainDst = join(standalone, "packages", "brain");
if (existsSync(join(brainSrc, "package.json"))) {
  mkdirSync(brainDst, { recursive: true });
  cpSync(brainSrc, brainDst, { recursive: true });
}

console.log("[stage-launcher] staged .next/static + public + supervisor + model scripts + shared Brain package into the standalone bundle");
