/** Shared paths/constants for the hub app. */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
/** Repo root (apps/hub/src → ../../..). */
export const REPO_ROOT = join(here, "..", "..", "..");
/** The user's notes — the source of the context graph (shared by hub + edge in Week-1). */
export const NOTES_DIR = join(REPO_ROOT, "data", "notes");
/** Voice memos (.wav) transcribed into the graph. */
export const VOICE_DIR = join(REPO_ROOT, "data", "voice");
/** Photos (.png/.jpg) OCR'd into the graph (kind:"photo"). */
export const PHOTOS_DIR = join(REPO_ROOT, "data", "photos");
/** The hub's vector workspace. */
export const HUB_WORKSPACE = "mycelium-hub";
/** Where the hub writes its audit JSONL. */
export const LOG_DIR = join(here, "..", "logs");
/** The hub's persistent Autobase corestore (the founding writer of the one mesh). */
export const MESH_STORE_DIR = join(here, "..", "data", "mesh-store");
/** Where the hub writes the blind-pairing invite for the edge to read. */
export const INVITE_FILE = join(here, "..", "data", "invite.txt");
/** Persisted set of node ids already embedded into HUB_WORKSPACE. */
export const EMBEDDED_IDS_FILE = join(here, "..", "data", "embedded-ids.json");

/** Trusted device writer-keys (hex `localWriterKey`) allowed to PAIR into the mesh. */
export const ALLOWLIST_FILE = join(here, "..", "data", "allowlist.json");
/**
 * Load the pairing allow-list: data/allowlist.json (JSON array of hex device keys)
 * unioned with MYCELIUM_ALLOWLIST (comma-separated). Empty set = open (back-compat).
 *
 * NOTE: these are MESH writer-keys, used for the blind-pairing firewall — NOT QVAC
 * delegation consumer pubkeys (a different keypair). The delegated-inference firewall
 * (provider.ts `allowedConsumer`) is therefore wired from a SEPARATE consumer-key
 * source, not this set; see main.ts.
 */
export function loadAllowlist(): Set<string> {
  const out = new Set<string>();
  if (existsSync(ALLOWLIST_FILE)) {
    try { for (const k of JSON.parse(readFileSync(ALLOWLIST_FILE, "utf-8")) as string[]) out.add(k.trim()); } catch { /* ignore malformed */ }
  }
  const env = process.env["MYCELIUM_ALLOWLIST"];
  if (env) for (const k of env.split(",")) if (k.trim()) out.add(k.trim());
  return out;
}
