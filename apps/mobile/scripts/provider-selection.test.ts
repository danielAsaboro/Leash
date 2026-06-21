import assert from "node:assert/strict";
import { pickProviderFromPeers, type MeshPeer } from "../providerSelection";

const now = Date.parse("2026-06-21T22:45:00.000Z");

function provider(models: MeshPeer["models"], inflight = 0): MeshPeer {
  return {
    deviceId: `device-${inflight}`,
    displayName: `provider-${inflight}`,
    computeClass: "desktop",
    isProvider: true,
    joinedAt: now - 10_000,
    lastSeen: new Date(now - 1_000).toISOString(),
    providerPublicKey: `provider-key-${inflight}`,
    models,
    inflight,
  };
}

const mixed = provider([
  { alias: "chat", modelSrc: "registry://chat", modelType: "chat", borrowable: true },
  { alias: "vision", modelSrc: "registry://vision", modelType: "vision", borrowable: true },
]);

assert.equal(pickProviderFromPeers([mixed], "chat", 45_000, now)?.alias, "chat");
assert.equal(pickProviderFromPeers([mixed], "vision", 45_000, now)?.alias, "vision");

const chatOnly = provider([
  { alias: "chat", modelSrc: "registry://chat", modelType: "chat", borrowable: true },
]);

assert.equal(pickProviderFromPeers([chatOnly], "vision", 45_000, now), null);

const busyVision = provider([
  { alias: "vision", modelSrc: "registry://vision", modelType: "vision", borrowable: true },
], 2);
const idleVision = provider([
  { alias: "vision", modelSrc: "registry://vision", modelType: "vision", borrowable: true },
], 0);

assert.equal(pickProviderFromPeers([busyVision, idleVision], "vision", 45_000, now)?.displayName, "provider-0");

console.log("provider-selection.test.ts: ok");
