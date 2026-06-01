/** Shared paths/constants for the hub app. */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** Repo root (apps/hub/src → ../../..). */
export const REPO_ROOT = join(here, "..", "..", "..");
/** The user's notes — the source of the context graph (shared by hub + edge in Week-1). */
export const NOTES_DIR = join(REPO_ROOT, "data", "notes");
/** Voice memos (.wav) transcribed into the graph. */
export const VOICE_DIR = join(REPO_ROOT, "data", "voice");
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
