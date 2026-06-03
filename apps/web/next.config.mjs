import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Prisma + the db workspace must stay external (native query engine, not bundled).
  serverExternalPackages: ["@prisma/client", "@mycelium/db"],
  // Monorepo: trace from the repo root so the workspace symlinks resolve.
  outputFileTracingRoot: join(here, "..", ".."),
};

export default nextConfig;
