/**
 * `@mycelium/db` — the newsroom database client.
 *
 * Exposes a single shared `PrismaClient` (the Next.js `globalThis` guard pattern so
 * dev hot-reload doesn't leak connections) pointed at one fixed SQLite file:
 * `packages/db/prisma/newsroom.db`. The path is resolved from THIS module's location
 * (not cwd), and passed explicitly via `datasourceUrl`, so the web app and the daemon
 * always open the same file no matter where the process started.
 *
 * SQLite is opened in WAL mode (one writer = the daemon, many readers = the web) with
 * a busy timeout so concurrent reads never throw SQLITE_BUSY.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const here = dirname(fileURLToPath(import.meta.url));
/** dist/index.js → packages/db ; src/index.ts → packages/db (both resolve the same). */
const PKG_ROOT = join(here, "..");
/** The one physical database, shared by web + daemon. */
export const DB_PATH = join(PKG_ROOT, "prisma", "newsroom.db");
const DATASOURCE_URL = `file:${DB_PATH}`;

const globalForPrisma = globalThis as unknown as { __myceliumPrisma?: PrismaClient };

/** The shared client. Import this everywhere — never `new PrismaClient()` directly. */
export const prisma: PrismaClient =
  globalForPrisma.__myceliumPrisma ?? new PrismaClient({ datasourceUrl: DATASOURCE_URL });
if (process.env["NODE_ENV"] !== "production") globalForPrisma.__myceliumPrisma = prisma;

/**
 * Put the database in WAL mode + a busy timeout so the web app can read while the
 * daemon writes. WAL is persisted in the db file header, so the writer only needs
 * to call this once at startup; readers inherit it. `$queryRawUnsafe` (not
 * `$executeRawUnsafe`) because `PRAGMA journal_mode` returns a row. Idempotent.
 */
export async function initDb(): Promise<void> {
  await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL;");
  await prisma.$queryRawUnsafe("PRAGMA busy_timeout=5000;");
}

export { PrismaClient, Prisma } from "@prisma/client";
export type {
  Edition,
  Article,
  Source,
  Claim,
  Dossier,
  DaemonRun,
  DaemonState,
} from "@prisma/client";

export * from "./enums.ts";
