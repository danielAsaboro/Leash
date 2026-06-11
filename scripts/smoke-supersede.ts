/**
 * Pure unit smoke for supersede-based ghost cleanup (packages/mesh/src/supersede.ts).
 *
 * A device's mesh writer key (`deviceId`) changes when its mesh store is reset/reinstalled, but its
 * `providerPublicKey`/`consumerPublicKey` (the seed-derived SDK identity) stays the same. So the SAME
 * identity reappearing in the SAME mesh under a NEW deviceId means the older deviceId is a dead ghost in
 * the grow-only membership CRDT. This proves `supersededDeviceIds` returns exactly those stale ids — and
 * NEVER a merely-offline device (which is why this is safe where an interval forget-stale is not).
 *
 *   npm run smoke:supersede
 */
import assert from "node:assert/strict";
import { supersededDeviceIds } from "../packages/mesh/src/supersede.ts";

function main(): void {
  // 1. Supersession: same identity + same mesh, new writer key replaces the old → forget the OLDER.
  const superseded = supersededDeviceIds([
    { deviceId: "writerOLD", providerPublicKey: "pubPRO", meshId: "primary", lastSeen: "2026-06-11T15:20:00Z" },
    { deviceId: "writerNEW", providerPublicKey: "pubPRO", meshId: "primary", lastSeen: "2026-06-11T17:54:00Z" },
  ]);
  assert.deepEqual(superseded, ["writerOLD"], "older writer key for the same identity+mesh is superseded");

  // 2. Different identities (two distinct devices) → forget nothing.
  assert.deepEqual(
    supersededDeviceIds([
      { deviceId: "wA", providerPublicKey: "pubA", meshId: "primary", lastSeen: "2026-06-11T10:00:00Z" },
      { deviceId: "wB", providerPublicKey: "pubB", meshId: "primary", lastSeen: "2026-06-11T17:00:00Z" },
    ]),
    [],
    "distinct identities are never superseded",
  );

  // 3. Same identity but DIFFERENT meshes → legit per-mesh writer keys, forget nothing.
  assert.deepEqual(
    supersededDeviceIds([
      { deviceId: "wHome", providerPublicKey: "pubPRO", meshId: "primary", lastSeen: "2026-06-11T10:00:00Z" },
      { deviceId: "wWork", providerPublicKey: "pubPRO", meshId: "work-mesh", lastSeen: "2026-06-11T17:00:00Z" },
    ]),
    [],
    "a device legitimately holds one writer key per mesh",
  );

  // 4. Consumer-only device (no providerPublicKey) groups by consumerPublicKey.
  assert.deepEqual(
    supersededDeviceIds([
      { deviceId: "cOLD", consumerPublicKey: "pubCON", meshId: "primary", lastSeen: "2026-06-11T09:00:00Z" },
      { deviceId: "cNEW", consumerPublicKey: "pubCON", meshId: "primary", lastSeen: "2026-06-11T18:00:00Z" },
    ]),
    ["cOLD"],
    "consumer-only caps supersede by consumerPublicKey",
  );

  // 5. Three writer keys for one identity → keep the newest, forget the two older.
  assert.deepEqual(
    supersededDeviceIds([
      { deviceId: "w1", providerPublicKey: "pubPRO", meshId: "primary", lastSeen: "2026-06-11T01:00:00Z" },
      { deviceId: "w3", providerPublicKey: "pubPRO", meshId: "primary", lastSeen: "2026-06-11T19:00:00Z" },
      { deviceId: "w2", providerPublicKey: "pubPRO", meshId: "primary", lastSeen: "2026-06-11T08:00:00Z" },
    ]).sort(),
    ["w1", "w2"],
    "keep the newest writer key, forget all older ones",
  );

  // 6. A single cap (the common case) → forget nothing.
  assert.deepEqual(
    supersededDeviceIds([{ deviceId: "wSolo", providerPublicKey: "pubX", meshId: "primary", lastSeen: "2026-06-11T12:00:00Z" }]),
    [],
    "a lone device is never superseded",
  );

  console.log("✅ supersede — older writer key forgotten on identity reuse; distinct/cross-mesh/lone devices untouched (6/6) — GO");
}

main();
