/**
 * Secret vault — AES-256-GCM encrypted key/value store for Leash's credentials
 * (Home Assistant token/URL, SearXNG URL, future keys). Moved into `@mycelium/leash-core`
 * so the `leash-tools-mcp` daemon's Home-Assistant group reads the SAME encrypted store as
 * the web process (the old `apps/web/lib/leash/vault.ts` is now a re-export shim).
 *
 *   · cipher: AES-256-GCM (Node built-in `crypto` — no dependency)
 *   · key:    `data/.leash-key` (32 random bytes, mode 0600, gitignored) — generated
 *             on first write; never ships with the repo
 *   · store:  `data/leash-secrets.enc` (gitignored) — `{ name: {iv, tag, ct} }`
 *
 * Threat model: protects a stolen DB/backup or leaked container layer — the ciphertext is
 * useless without the key file. Does NOT protect against process compromise. For a
 * single-user on-device exocortex that's the right bar.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, chmodSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { DATA_DIR } from "./paths.ts";

const KEY_FILE = process.env["LEASH_VAULT_KEY"] ?? join(DATA_DIR, ".leash-key");
const STORE_FILE = process.env["LEASH_VAULT_STORE"] ?? join(DATA_DIR, "leash-secrets.enc");

/** Secrets Leash knows how to use (UI lists these; values masked). `env` = back-compat fallback. */
export const KNOWN_SECRETS: { name: string; label: string; hint: string; env: string }[] = [
  { name: "LEASH_HA_URL", label: "Home Assistant URL", hint: "e.g. http://homeassistant.local:8123", env: "LEASH_HA_URL" },
  { name: "LEASH_HA_TOKEN", label: "Home Assistant token", hint: "Long-lived access token", env: "LEASH_HA_TOKEN" },
  { name: "LEASH_SEARXNG_URL", label: "SearXNG URL", hint: "Self-hosted meta-search for deep research; blank = DuckDuckGo", env: "LEASH_SEARXNG_URL" },
];

interface Enc {
  iv: string;
  tag: string;
  ct: string;
}

function loadKey(): Buffer {
  if (existsSync(KEY_FILE)) return Buffer.from(readFileSync(KEY_FILE, "utf8").trim(), "hex");
  const key = randomBytes(32);
  writeFileSync(KEY_FILE, key.toString("hex"), { mode: 0o600 });
  try {
    chmodSync(KEY_FILE, 0o600);
  } catch {
    /* best effort on platforms without chmod */
  }
  return key;
}

function readStore(): Record<string, Enc> {
  try {
    return JSON.parse(readFileSync(STORE_FILE, "utf8")) as Record<string, Enc>;
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, Enc>): void {
  const tmp = join(dirname(STORE_FILE), `.secrets-${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(tmp, STORE_FILE);
}

/** Encrypt + store one secret (empty/whitespace value deletes it). */
export function setSecret(name: string, value: string): void {
  const store = readStore();
  if (!value.trim()) {
    delete store[name];
    writeStore(store);
    return;
  }
  const key = loadKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  store[name] = { iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ct: ct.toString("hex") };
  writeStore(store);
}

/** Decrypt one secret from the vault (NOT the env fallback). null if unset/undecryptable. */
export function getVaultSecret(name: string): string | null {
  const enc = readStore()[name];
  if (!enc) return null;
  try {
    const key = loadKey();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(enc.iv, "hex"));
    decipher.setAuthTag(Buffer.from(enc.tag, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(enc.ct, "hex")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * The effective secret: vault first, then the env var (back-compat), then "". This is
 * what consumers (HA tools, SearXNG search) should call.
 */
export function getSecret(name: string): string {
  const v = getVaultSecret(name);
  if (v !== null && v !== "") return v;
  const known = KNOWN_SECRETS.find((k) => k.name === name);
  return (process.env[known?.env ?? name] ?? "").trim();
}

export interface SecretStatus {
  name: string;
  label: string;
  hint: string;
  /** Set in the vault. */
  inVault: boolean;
  /** Present via the env-var fallback (and not overridden in the vault). */
  fromEnv: boolean;
}

/** Status of every known secret — names + where it resolves, NEVER the value. */
export function listSecretStatus(): SecretStatus[] {
  const store = readStore();
  return KNOWN_SECRETS.map((k) => {
    const inVault = !!store[k.name];
    return { name: k.name, label: k.label, hint: k.hint, inVault, fromEnv: !inVault && !!(process.env[k.env] ?? "").trim() };
  });
}

/** Remove a secret from the vault. */
export function deleteSecret(name: string): void {
  const store = readStore();
  if (store[name]) {
    delete store[name];
    writeStore(store);
  }
}
