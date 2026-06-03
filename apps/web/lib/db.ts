/** The shared newsroom database client (singleton from @mycelium/db). */
import "server-only";
export { prisma } from "@mycelium/db";
export type { Article, Source, Claim, Dossier, Edition, DaemonRun, DaemonState } from "@mycelium/db";
