// Supersede-based ghost cleanup for the grow-only membership CRDT.
//
// A capability is keyed by `deviceId` = the device's mesh-autobase WRITER key, which CHANGES when the
// device's mesh store is reset/reinstalled. Its `providerPublicKey`/`consumerPublicKey` (the seed-derived
// SDK identity) is STABLE across that. So when the SAME identity reappears in the SAME mesh under a NEW
// deviceId, the older deviceId is a dead ghost the append-only set never reclaims on its own.
//
// `supersededDeviceIds` returns exactly those stale ids for `forgetCapability`. This is SAFE where a
// staleness timer is NOT: it only ever drops a writer key that has been REPLACED by a newer one for the
// same identity+mesh — never a device that is merely offline (a closed laptop keeps its one writer key).

/** The capability fields supersession needs — a structural subset of `DeviceCapability`. */
export interface SupersedeCap {
  deviceId: string;
  providerPublicKey?: string;
  consumerPublicKey?: string;
  meshId?: string;
  /** ISO timestamp. */
  lastSeen: string;
}

/**
 * Stale (superseded) writer keys to forget: for each (stable identity, mesh) seen under more than one
 * `deviceId`, every deviceId EXCEPT the most-recently-seen one. Caps without a stable identity are
 * skipped (nothing to anchor supersession to).
 */
export function supersededDeviceIds(caps: readonly SupersedeCap[]): string[] {
  const groups = new Map<string, SupersedeCap[]>();
  for (const c of caps) {
    const identity = c.providerPublicKey ?? c.consumerPublicKey;
    if (identity === undefined || identity === "") continue;
    const key = `${identity}::${c.meshId ?? ""}`;
    const arr = groups.get(key);
    if (arr) arr.push(c);
    else groups.set(key, [c]);
  }

  const forget: string[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    let newest = group[0]!;
    for (const c of group) {
      if (Date.parse(c.lastSeen) > Date.parse(newest.lastSeen)) newest = c;
    }
    for (const c of group) {
      if (c.deviceId !== newest.deviceId) forget.push(c.deviceId);
    }
  }
  return forget;
}
