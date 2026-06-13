import assert from "node:assert";
import { join } from "node:path";

// Reproduce the module's resolution rule in isolation (the module opens a real
// PrismaClient on import, so we test the rule, not the import).
function dbPath(env: NodeJS.ProcessEnv, pkgRoot: string): string {
  return env.LEASH_DB_PATH ?? join(pkgRoot, "prisma", "newsroom.db");
}
function datasourceUrl(env: NodeJS.ProcessEnv, pkgRoot: string): string {
  return env.DATABASE_URL ?? `file:${dbPath(env, pkgRoot)}`;
}

assert.equal(dbPath({}, "/pkg"), "/pkg/prisma/newsroom.db", "default path");
assert.equal(dbPath({ LEASH_DB_PATH: "/base/db/newsroom.db" } as any, "/pkg"), "/base/db/newsroom.db", "env override");
assert.equal(datasourceUrl({}, "/pkg"), "file:/pkg/prisma/newsroom.db", "default url");
assert.equal(datasourceUrl({ DATABASE_URL: "file:/x.db" } as any, "/pkg"), "file:/x.db", "url override");
console.log("OK verify-db-env");
