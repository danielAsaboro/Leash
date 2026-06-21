import assert from "node:assert/strict";
import { createForwardSwarm } from "../worklets/forward-swarm.mjs";

let capturedKey: Buffer | null = null;
let capturedOpts: Record<string, unknown> | undefined;

class FakeSwarm {
  dht = {
    connect(key: Buffer, opts?: Record<string, unknown>) {
      capturedKey = key;
      capturedOpts = opts;
      return "connected";
    },
  };
}

const swarm = createForwardSwarm(FakeSwarm);
const key = Buffer.from("provider");

assert.equal(swarm.dht.connect(key, { reusableSocket: true }), "connected");
assert.equal(capturedKey, key);
assert.deepEqual(capturedOpts, { reusableSocket: true, localConnection: false });

capturedOpts = undefined;
assert.equal(swarm.dht.connect(key, { localConnection: true }), "connected");
assert.deepEqual(capturedOpts, { localConnection: false }, "forward swarm must disable the LAN shortcut");

console.log("forward-swarm.test.ts: ok");
