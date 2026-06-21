import assert from "node:assert/strict";
import { forceRelayConnect } from "../worklets/swarm-options.mjs";

let capturedKey: Buffer | null = null;
let capturedOpts: Record<string, unknown> | undefined;
const swarm = {
  dht: {
    connect(key: Buffer, opts?: Record<string, unknown>) {
      capturedKey = key;
      capturedOpts = opts;
      return "connected";
    },
  },
};

assert.equal(forceRelayConnect(swarm), true, "wrapper should install when swarm has a dht connect method");

const key = Buffer.from("peer");
assert.equal(swarm.dht.connect(key, { reusableSocket: true }), "connected");
assert.equal(capturedKey, key);
assert.deepEqual(capturedOpts, { reusableSocket: true, localConnection: false });

capturedOpts = undefined;
assert.equal(swarm.dht.connect(key, { localConnection: true }), "connected");
assert.deepEqual(capturedOpts, { localConnection: false }, "wrapper should override caller localConnection");

assert.equal(forceRelayConnect({}), false, "wrapper should no-op without a dht");

console.log("mesh-swarm.test.ts: ok");
