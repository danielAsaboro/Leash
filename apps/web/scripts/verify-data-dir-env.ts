import assert from "node:assert";
import { join } from "node:path";
function dataDir(env: NodeJS.ProcessEnv, here: string): string {
  return env.LEASH_DATA_DIR ?? join(here, "..", "..", "..", "..", "data");
}
assert.equal(dataDir({}, "/root/apps/web/lib/leash"), "/root/data", "default");
assert.equal(dataDir({ LEASH_DATA_DIR: "/base/data" } as any, "/x"), "/base/data", "override");
console.log("OK verify-data-dir-env");
