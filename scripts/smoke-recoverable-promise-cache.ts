import assert from "node:assert/strict";
import { RecoverablePromiseCache } from "@mycelium/leash-core/recoverable-promise-cache";

const cache = new RecoverablePromiseCache<number>();
let loads = 0;

await assert.rejects(
  cache.get("skills-v1", async () => {
    loads++;
    throw new Error("serve temporarily unavailable");
  }),
  /temporarily unavailable/,
);

const recovered = await cache.get("skills-v1", async () => ++loads);
assert.equal(recovered, 2, "a rejected fill must be retried");
assert.equal(await cache.get("skills-v1", async () => ++loads), 2, "a successful fill is reused");

const next = await Promise.all([
  cache.get("skills-v2", async () => {
    loads++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return loads;
  }),
  cache.get("skills-v2", async () => ++loads),
]);
assert.deepEqual(next, [3, 3], "concurrent callers share the same keyed load");
assert.equal(loads, 3);

console.log("recoverable-promise-cache smoke passed");
