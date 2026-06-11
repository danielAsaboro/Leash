/**
 * Pure-logic smoke for the Settings → Storage model-cache list helpers
 * (apps/web/lib/leash/storage-paging.ts). Proves clamped 1-based paging, a partial last
 * page, empty-list safety, garbage-input clamping, and selected-bytes summation.
 *   npm run smoke:storage-paging
 */
import assert from "node:assert/strict";
import { paginate, sumSelectedBytes } from "../apps/web/lib/leash/storage-paging.ts";

const items = Array.from({ length: 23 }, (_, i) => i);
let p = paginate(items, 1, 8);
assert.equal(p.pages, 3, "ceil(23/8)=3");
assert.equal(p.slice.length, 8);
assert.equal(p.slice[0], 0);
assert.equal(p.hasPrev, false);
assert.equal(p.hasNext, true);

p = paginate(items, 9, 8); // over-range clamps to last
assert.equal(p.page, 3, "page clamps to last");
assert.equal(p.slice.length, 7, "23-16=7 on last page");
assert.equal(p.hasNext, false);
assert.equal(p.hasPrev, true);

p = paginate([], 1, 8); // empty → one empty page
assert.equal(p.pages, 1);
assert.equal(p.total, 0);
assert.equal(p.slice.length, 0);
assert.equal(p.hasPrev, false);
assert.equal(p.hasNext, false);

assert.equal(paginate(items, 0, 8).page, 1, "page 0 clamps to 1");
assert.equal(paginate(items, -5, 8).page, 1, "negative clamps to 1");
assert.equal(paginate(items, 1, 0).pages, 23, "perPage floored to 1 (no div-by-zero)");

const files = [{ file: "a", bytes: 100 }, { file: "b", bytes: 250 }, { file: "c", bytes: 50 }];
assert.equal(sumSelectedBytes(files, new Set(["a", "c"])), 150);
assert.equal(sumSelectedBytes(files, new Set()), 0);
assert.equal(sumSelectedBytes(files, new Set(["a", "b", "c"])), 400);

console.log("✅ storage-paging — clamped 1-based paging · partial last page · empty-safe · selected-bytes sum — GO");
