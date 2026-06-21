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

const tiedA = { ...provider(chatOnly.models, 0), deviceId: "device-a", displayName: "A", providerPublicKey: "provider-key-a" };
const tiedB = { ...provider(chatOnly.models, 0), deviceId: "device-b", displayName: "B", providerPublicKey: "provider-key-b" };
assert.equal(
  pickProviderFromPeers([tiedB, tiedA], "chat", 45_000, now)?.providerPublicKey,
  "provider-key-a",
  "equal-load fallback is deterministic regardless of roster order",
);
assert.equal(
  pickProviderFromPeers([tiedA, tiedB], "chat", 45_000, now, "provider-key-b")?.providerPublicKey,
  "provider-key-b",
  "the current provider remains sticky while tied on load",
);
assert.equal(
  pickProviderFromPeers([{ ...tiedA, inflight: 0 }, { ...tiedB, inflight: 2 }], "chat", 45_000, now, "provider-key-b")?.providerPublicKey,
  "provider-key-a",
  "stickiness never overrides a genuinely less-loaded provider",
);

console.log("provider-selection.test.ts: ok");
