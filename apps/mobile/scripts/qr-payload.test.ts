import assert from "node:assert/strict";
import { parseMeshInvitePayload } from "../qrPayload";

const invite = "ab".repeat(80);
const sid = "11111111-2222-4333-8444-555555555555";

assert.deepEqual(parseMeshInvitePayload(`leash://join?invite=${invite}&sid=${sid}&mesh=primary`), {
  invite,
  sid,
  mesh: "primary",
});

assert.deepEqual(parseMeshInvitePayload(JSON.stringify({ invite, sid, mesh: "primary" })), {
  invite,
  sid,
  mesh: "primary",
});

assert.deepEqual(parseMeshInvitePayload(invite), { invite });
assert.equal(parseMeshInvitePayload("leash://join?invite=nothex&sid=" + sid), null);

console.log("qr-payload.test.ts: ok");
