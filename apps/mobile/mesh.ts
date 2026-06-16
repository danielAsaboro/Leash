import * as FileSystem from "expo-file-system/legacy";
import { heartbeat } from "@qvac/sdk";

/**
 * Mesh offload config — the phone can delegate inference to a provider on the private
 * mesh (a "strong brain" running `startQVACProvider`). Persisted locally so the pairing
 * survives restarts. The provider's public key IS the capability; the transport is
 * Noise-encrypted over Holepunch/Hyperswarm by design.
 */

export type MeshConfig = { providerKey: string; meshOn: boolean; cb?: string; providerName?: string };

/** Best-effort tell the pairing web page whether this phone is connected, so it can flip
 *  between the success screen and the QR. Fire-and-forget — the app never depends on it. */
export async function notifyPairing(cb: string | undefined, device: string, connected: boolean): Promise<void> {
  if (!cb) return;
  try {
    await fetch(cb, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device, connected }),
    });
  } catch {
    /* the web page may be closed/unreachable — harmless */
  }
}

/**
 * Default mesh provider — a delegated-compute node (this build's dev Mac, started with a
 * fixed seed so its key is stable across restarts). Pre-paired so the app offloads out of
 * the box; override it in the Mesh sheet to point at any provider on your mesh.
 */
export const DEFAULT_PROVIDER_KEY = "6035ed47dc94d96f434ff77e7f0955f0e7a3da5bae6cfddeb935be44e73af87e";

const FILE = `${FileSystem.documentDirectory}mesh.json`;
const EMPTY: MeshConfig = { providerKey: DEFAULT_PROVIDER_KEY, meshOn: true };

export async function loadMeshConfig(): Promise<MeshConfig> {
  try {
    const info = await FileSystem.getInfoAsync(FILE);
    if (!info.exists) return EMPTY;
    const raw = await FileSystem.readAsStringAsync(FILE);
    const parsed = JSON.parse(raw) as Partial<MeshConfig>;
    return {
      providerKey: parsed.providerKey || DEFAULT_PROVIDER_KEY,
      meshOn: parsed.meshOn ?? true,
      cb: parsed.cb,
      providerName: parsed.providerName,
    };
  } catch {
    return EMPTY;
  }
}

export async function saveMeshConfig(cfg: MeshConfig): Promise<void> {
  try {
    await FileSystem.writeAsStringAsync(FILE, JSON.stringify(cfg));
  } catch {
    /* best-effort — the app still works for the session without persistence */
  }
}

/** A provider public key is 64 lowercase hex chars (a hyperswarm/DHT public key). */
export function isValidProviderKey(k: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(k.trim());
}

/** Round-trip ping the provider. Resolves true if it answered within the timeout. */
export async function pingProvider(providerKey: string, timeout = 5000): Promise<boolean> {
  try {
    const res: any = await (heartbeat as any)({ delegate: { providerPublicKey: providerKey.trim(), timeout } });
    // The SDK resolves on a successful round-trip; tolerate either a boolean or an object.
    return res === undefined || res === true || res?.ok === true || res?.alive === true || !!res;
  } catch {
    return false;
  }
}
