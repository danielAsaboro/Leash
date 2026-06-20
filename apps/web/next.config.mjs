import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Self-contained server bundle for the Leash desktop app (apps/desktop ships
  // .next/standalone and runs `node server.js`). Harmless to normal dev/start —
  // it only emits an extra .next/standalone dir at build time.
  output: "standalone",
  // The standalone build's job is to emit a runnable server bundle, not to
  // type/lint-gate (the app is type-checked separately and runs via `next dev`).
  // `next build` type-checks the whole tree and trips on latent type-only drift
  // (e.g. the `ai` package renaming an exported type) that never affects the
  // compiled JS — don't let that block packaging.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  // Prisma + the db workspace must stay external (native query engine, not bundled).
  // bash-tool → just-bash pulls a native addon (@mongodb-js/zstd/*.node) webpack can't
  // bundle — externalize the chain so it's require()d at runtime (Brain → MCP/files bash tools).
  serverExternalPackages: ["@prisma/client", "@mycelium/db", "@mycelium/senses", "@qvac/sdk", "bash-tool", "just-bash", "@mongodb-js/zstd"],
  // Monorepo: trace from the repo root so the workspace symlinks resolve.
  outputFileTracingRoot: join(here, "..", ".."),
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // The hoisted `node_modules/process` is **bare-process** (pulled in by `@qvac/sdk`
      // via `process@npm:bare-process`). If Next uses it as the browser `process`
      // polyfill, the whole Bare runtime (`bare-abort/binding.js`, which calls a missing
      // native addon) lands in the client bundle and throws at eval — killing React
      // hydration on every page (dead buttons, no ⌘K, no "Read aloud"). Point `process`
      // at a browser shim and hard-stub the Bare runtime so it can never enter the client.
      config.resolve = config.resolve || {};
      config.resolve.alias = {
        ...(config.resolve.alias || {}),
        process: join(here, "process-browser.cjs"),
        "bare-process": false,
        "bare-abort": false,
        "bare-events": false,
        "bare-os": false,
        "bare-fs": false,
        "bare-stdio": false,
        "bare-signals": false,
        "bare-env": false,
        "bare-hrtime": false,
        "bare-path": false,
        "bare-tty": false,
        "bare-url": false,
        "bare-pipe": false,
        "bare-stream": false,
      };
    }
    return config;
  },
};

export default nextConfig;
