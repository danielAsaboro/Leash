import assert from "node:assert/strict";
import { createMessageIdFactory } from "../message-id";

const firstLaunch = createMessageIdFactory(() => 1_000, () => 0.1);
const secondLaunch = createMessageIdFactory(() => 1_000, () => 0.2);

const firstIds = [firstLaunch(), firstLaunch(), firstLaunch()];
const secondIds = [secondLaunch(), secondLaunch(), secondLaunch()];

assert.equal(new Set(firstIds).size, firstIds.length, "one launch must not reuse an ID");
assert.equal(
  new Set([...firstIds, ...secondIds]).size,
  firstIds.length + secondIds.length,
  "a restart in the same millisecond must still use a distinct session prefix",
);
assert.ok(
  [...firstIds, ...secondIds].every((id) => !/^m\d+$/.test(id)),
  "new IDs must not collide with persisted counter IDs such as m1/m2",
);

console.log("message-id.test.ts: ok");
