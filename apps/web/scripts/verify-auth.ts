import assert from "node:assert";
import { makeUser, verifyPassword, signSession, verifySession, parseSession, rotate, slugifyUserId } from "../lib/leash/auth-core.ts";

// slugifyUserId — path-safe, deterministic, dot-free (tokens split on ".")
const uid = slugifyUserId("Ada Lovelace");
assert.match(uid, /^ada-lovelace-[0-9a-f]{8}$/, "slug+hash");
assert.equal(slugifyUserId("Ada Lovelace"), uid, "deterministic");
assert.ok(!uid.includes("."), "userId carries no dot");

const u = makeUser("ada", uid, "hunter2");
assert.equal(u.userId, uid);
assert.equal(verifyPassword(u, "hunter2"), true, "correct pw");
assert.equal(verifyPassword(u, "wrong"), false, "wrong pw");
assert.throws(() => makeUser("ada", uid, "123"), /too short/, "min length");

const now = 1_000_000;
const tok = signSession(u, now);
assert.deepEqual(parseSession(tok), { userId: uid, iat: now }, "parse carries userId+iat");
assert.equal(verifySession(u, tok, now + 5_000), true, "valid token");
assert.equal(verifySession(u, undefined, now), false, "no token");
assert.equal(verifySession(u, "garbage", now), false, "garbage token");
assert.equal(verifySession(u, tok.slice(0, -2) + "00", now), false, "tampered sig");
assert.equal(verifySession(u, `${uid}.${now + 10_000_000}.deadbeef`, now), false, "future iat rejected");

// a token for a DIFFERENT user must not verify against this user's secret
const other = makeUser("bob", slugifyUserId("bob"), "hunter2");
assert.equal(verifySession(u, signSession(other, now), now + 5_000), false, "cross-user token rejected");

const r = rotate(u);
assert.equal(verifySession(r, tok, now + 5_000), false, "old token dead after rotate");
assert.equal(verifyPassword(r, "hunter2"), true, "rotate keeps password");
console.log("OK verify-auth");
