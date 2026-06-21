import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PublicReplayGuard } from "../src/public-compute-control.ts";

const file = join(mkdtempSync(join(tmpdir(), "leash-public-replay-")), "seen.json");
const requester = "a".repeat(64), job = "12345678-1234-1234-1234-123456789abc", nonce = "b".repeat(64);
const now = Date.now();
const first = new PublicReplayGuard(file, 1_000, 4);
assert.equal(first.accept(requester, job, nonce, now), true);
assert.equal(first.accept(requester, job, nonce, now + 1), false, "same job/nonce rejected");
const restarted = new PublicReplayGuard(file, 1_000, 4);
assert.equal(restarted.accept(requester, job, nonce, now + 2), false, "replay remains rejected across restart");
assert.equal(restarted.accept(requester, job, "c".repeat(64), now + 2), false, "same job id with a rotated nonce remains a replay");
assert.equal(restarted.accept(requester, "22345678-1234-1234-1234-123456789abc", nonce, now + 2), false, "same nonce with a rotated job id remains a replay");
assert.equal(restarted.accept(requester, "22345678-1234-1234-1234-123456789abc", "c".repeat(64), now + 2), true, "a distinct job id and nonce are accepted");
assert.equal(restarted.accept(requester, job, nonce, now + 1_001), true, "expired replay entry may be pruned");
console.log("✅ public-compute replay — job IDs and nonces remain unique across rotation and restart; expiry bounded");
