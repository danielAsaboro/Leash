/**
 * Smoke: the multi-mesh delegation policy (spec §4 union firewall + §6 ladder/eligibility).
 *
 *   npx tsx packages/mesh/scripts/smoke-delegation-policy.ts
 *
 * Pure-function smoke — exercises the EXACT decisions the daemon delegates to: which consumers
 * the device-global provider allows (union), and which mesh answers an offload (the hierarchical
 * ladder, capped by the request's privacy class). No I/O, fully deterministic.
 */
import type { DeviceCapability } from "@mycelium/shared";
import { unionAllowedConsumers, routeDelegation, isRouteHit, type MeshCandidate } from "../src/index.ts";

function expect(label: string, cond: boolean): void {
  if (!cond) throw new Error(`FAILED: ${label}`);
  console.log(`✅ ${label}`);
}

const cap = (over: Partial<DeviceCapability>): DeviceCapability => ({
  deviceId: "dev", displayName: "d", computeClass: "mac", ramMB: 16000, powerState: "plugged",
  availableModels: [], isProvider: true, lastSeen: new Date(0).toISOString(), ...over,
});

// peers: home mesh {pro}, work mesh {laptop}; SELF appears in both and must be excluded.
const SELF = "self-key";
const homeCaps: DeviceCapability[] = [
  cap({ deviceId: "self", providerPublicKey: SELF, consumerPublicKey: SELF }),
  cap({ deviceId: "pro", providerPublicKey: "pro-key", consumerPublicKey: "pro-consumer" }),
];
const workCaps: DeviceCapability[] = [
  cap({ deviceId: "self", providerPublicKey: SELF, consumerPublicKey: SELF }),
  cap({ deviceId: "laptop", providerPublicKey: "laptop-key", consumerPublicKey: "laptop-consumer" }),
];

try {
  // ── UNION FIREWALL (§4) ───────────────────────────────────────────────────────────────────
  const allow = unionAllowedConsumers([homeCaps, workCaps], SELF);
  expect("union allows both meshes' peer consumer keys", allow.has("pro-consumer") && allow.has("laptop-consumer"));
  expect("union NEVER allow-lists ourselves", !allow.has(SELF));
  expect("union is exactly the two peers", allow.size === 2);
  const allowMinusForgotten = unionAllowedConsumers([homeCaps, workCaps], SELF, (id) => id === "laptop");
  expect("a tombstoned peer is dropped from the union", allowMinusForgotten.has("pro-consumer") && !allowMinusForgotten.has("laptop-consumer"));

  // ── DELEGATION LADDER (§6) ────────────────────────────────────────────────────────────────
  // home = tier 0 (private), work = tier 1 (private), publicCell = tier 2 (public)
  const warmHome: MeshCandidate = { meshId: "home", tier: 0, visibility: "private", warm: { modelId: "m-home", peerKey: "pro", inflight: 1 } };
  const coldHome: MeshCandidate = { meshId: "home", tier: 0, visibility: "private" };
  const warmWork: MeshCandidate = { meshId: "work", tier: 1, visibility: "private", warm: { modelId: "m-work", peerKey: "laptop", inflight: 0 } };
  const warmPublic: MeshCandidate = { meshId: "cell", tier: 2, visibility: "public", warm: { modelId: "m-pub", peerKey: "stranger", inflight: 0 } };

  // 1. Home first, even though work has a lower-inflight peer — tier beats load.
  const r1 = routeDelegation({ alias: "chat" }, [warmWork, warmHome]);
  expect("ladder tries the highest tier (home) first, not the least-loaded", isRouteHit(r1) && r1.meshId === "home");

  // 2. Home cold → fall through to work (capacity fall-through).
  const r2 = routeDelegation({ alias: "chat" }, [coldHome, warmWork]);
  expect("cold home falls through to the next tier (work)", isRouteHit(r2) && r2.meshId === "work");

  // 3. DEFAULT sensitivity is private → a public mesh is NEVER selected, even if it's the only warm one.
  const r3 = routeDelegation({ alias: "chat" }, [coldHome, warmPublic]);
  expect("default-private request never reaches a public mesh (misses instead)", !isRouteHit(r3) && r3.reason === "no-warm-peer");

  // 4. Explicitly shareable → may fall through to the public tier.
  const r4 = routeDelegation({ alias: "chat", sensitivity: "shareable" }, [coldHome, warmPublic]);
  expect("a shareable request MAY use the public mesh", isRouteHit(r4) && r4.meshId === "cell");

  // 5. Hard pin to home → does NOT fall through to work even when home is cold (the §12 cap).
  const r5 = routeDelegation({ alias: "chat", pinMeshId: "home" }, [coldHome, warmWork]);
  expect("a request pinned to home does NOT fall through to work (eligibility cap holds)", !isRouteHit(r5) && r5.reason === "no-warm-peer");

  // 6. maxTier cap → won't escalate past tier 0.
  const r6 = routeDelegation({ alias: "chat", maxTier: 0 }, [coldHome, warmWork]);
  expect("maxTier:0 won't escalate past tier 0", !isRouteHit(r6) && r6.reason === "no-warm-peer");

  // 7. Within the same tier, the lower-inflight peer wins.
  const homeA: MeshCandidate = { meshId: "a", tier: 0, visibility: "private", warm: { modelId: "mA", peerKey: "A", inflight: 3 } };
  const homeB: MeshCandidate = { meshId: "b", tier: 0, visibility: "private", warm: { modelId: "mB", peerKey: "B", inflight: 0 } };
  const r7 = routeDelegation({ alias: "chat" }, [homeA, homeB]);
  expect("same-tier tiebreak prefers the lower-inflight peer", isRouteHit(r7) && r7.meshId === "b");

  console.log("\n🟢 PASS — union firewall + delegation ladder + eligibility cap all hold");
} catch (err) {
  console.error("\n🔴 FAIL:", err);
  process.exitCode = 1;
}
