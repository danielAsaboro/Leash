import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The marketing site is type-checked separately; don't let latent type drift gate the deploy.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  async redirects() {
    return [
      {
        source: "/hackathon/known-issues",
        destination: "https://docs.useleash.xyz/hackathon/known-issues",
        permanent: true,
      },
    ];
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // The hoisted root `node_modules/process` is **bare-process** (pulled in by `@qvac/sdk`
      // elsewhere in the monorepo and hoisted to the shared root). React references `process`,
      // so without this alias the Bare runtime (`bare-abort/binding.js`, a missing native addon)
      // lands in the client bundle and throws at eval — breaking React hydration. Point `process`
      // at a browser shim and hard-stub the Bare runtime so it can never enter the client bundle.
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
