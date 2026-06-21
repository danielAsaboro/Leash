/**
 * On-device secret vault — the mobile analogue of the desktop vault.ts (packages/leash-core).
 * Desktop encrypts with node:crypto + a key file; that can't run on JSC, so the right RN primitive
 * is the iOS Keychain via expo-secure-store. Values are written to the Keychain and NEVER read back
 * into the UI — the screen only ever shows set / not-set status, exactly like SecretsCard.
 *
 * Same KNOWN_SECRETS set as the desktop vault (Home Assistant URL/token, SearXNG URL). These are
 * consumed by connectors that run on the paired desktop Leash; storing them here lets the phone be
 * the single place a user manages them. (The mesh pairing key is a PUBLIC capability, not a secret —
 * it lives on the Mesh screen, not here.)
 */
import * as SecureStore from "expo-secure-store";
import { KNOWN_SECRETS, type KnownSecret } from "./knownSecrets";

export type SecretStatus = KnownSecret & { set: boolean };

/** Keychain keys must be alphanumeric + ._- ; our names already qualify, but normalize defensively. */
const keyFor = (name: string): string => name.replace(/[^A-Za-z0-9._-]/g, "_");

/** List set/not-set status for every known secret — never the value itself. */
export async function listSecretStatus(): Promise<SecretStatus[]> {
  const out: SecretStatus[] = [];
  for (const s of KNOWN_SECRETS) {
    let set = false;
    try {
      set = (await SecureStore.getItemAsync(keyFor(s.name))) != null;
    } catch {
      set = false;
    }
    out.push({ ...s, set });
  }
  return out;
}

export async function setSecret(name: string, value: string): Promise<void> {
  const v = value.trim();
  if (!v) return deleteSecret(name);
  await SecureStore.setItemAsync(keyFor(name), v);
}

export async function deleteSecret(name: string): Promise<void> {
  await SecureStore.deleteItemAsync(keyFor(name)).catch(() => {});
}

export async function clearSecrets(names: string[] = KNOWN_SECRETS.map((secret) => secret.name)): Promise<void> {
  await Promise.all(names.map((name) => SecureStore.deleteItemAsync(keyFor(name)).catch(() => {})));
}
