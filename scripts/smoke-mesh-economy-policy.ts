import assert from "node:assert/strict";
import type { SettlementEndpoint, Visibility } from "@mycelium/shared";
import {
  MAX_PRIVATE_MESHES,
  MAX_PUBLIC_MESHES,
  advertisedPriceForMesh,
  membershipLimitError,
  paidSessionValidationError,
  paidRailsForMesh,
  requiresPaidSessionForMesh,
} from "../apps/hypha/src/mesh-economy-policy.ts";

const rail = (pricePerKiloToken: number): SettlementEndpoint => ({
  network: "plasma",
  networkId: "eip155:9746",
  asset: "USDT0",
  mint: "0xUSDT0",
  decimals: 6,
  recipient: "0x0000000000000000000000000000000000000001",
  x402: {
    version: 2,
    scheme: "upto",
    facilitator: "http://127.0.0.1:4020",
    maxTimeoutSeconds: 900,
    pricePerKiloToken,
  },
});

const record = (meshId: string, visibility: Visibility) => ({ meshId, visibility });

assert.equal(MAX_PRIVATE_MESHES, 1);
assert.equal(MAX_PUBLIC_MESHES, 15);

assert.equal(membershipLimitError([], "private"), null, "first private mesh is allowed");
assert.match(
  membershipLimitError([record("primary", "private")], "private") ?? "",
  /one private mesh/i,
  "second private mesh is rejected",
);
assert.equal(
  membershipLimitError([record("primary", "private")], "private", "primary"),
  null,
  "reopening the existing private mesh does not count against the cap",
);

const publicRecords = Array.from({ length: 15 }, (_, i) => record(`pub-${i}`, "public"));
assert.equal(membershipLimitError(publicRecords.slice(0, 14), "public"), null, "fifteenth public mesh is allowed");
assert.match(membershipLimitError(publicRecords, "public") ?? "", /15 public meshes/i, "sixteenth public mesh is rejected");
assert.equal(membershipLimitError(publicRecords, "public", "pub-3"), null, "reopening an existing public mesh does not count against the cap");

assert.equal(advertisedPriceForMesh("private", 500), 0, "private price is always zero");
assert.equal(advertisedPriceForMesh("public", 0), 0, "public free price stays zero");
assert.equal(advertisedPriceForMesh("public", 500), 500, "public paid price is advertised");

assert.equal(requiresPaidSessionForMesh("private", 500, true), false, "private never requires paid session");
assert.equal(requiresPaidSessionForMesh("public", 0, true), false, "public free never requires paid session");
assert.equal(requiresPaidSessionForMesh("public", 500, false), false, "public paid price without a rail is not a paid session");
assert.equal(requiresPaidSessionForMesh("public", 500, true), true, "public paid route requires session");
assert.match(paidSessionValidationError("private") ?? "", /private mesh compute is free/i, "private paid sessions are rejected");
assert.equal(paidSessionValidationError("public"), null, "public paid sessions may proceed to budget validation");

assert.deepEqual(paidRailsForMesh("private", [rail(500)]), [], "private mesh suppresses paid rails");
assert.deepEqual(paidRailsForMesh("public", [rail(0)]), [], "public zero-price rail is not advertised as paid");
assert.equal(paidRailsForMesh("public", [rail(500)]).length, 1, "public nonzero rail is advertised");

console.log("✅ mesh economy policy — membership caps · private zero-rate · public free/paid session gate — GO");
