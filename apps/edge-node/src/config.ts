/** Shared paths/constants for the edge-node app. */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** Repo root (apps/edge-node/src → ../../..). */
export const REPO_ROOT = join(here, "..", "..", "..");
/** Shared notes/voice the edge can also sense (edge→hub demo path). */
export const NOTES_DIR = join(REPO_ROOT, "data", "notes");
export const VOICE_DIR = join(REPO_ROOT, "data", "voice");
/** The edge's persistent Autobase corestore (a permanent writer across runs). */
export const MESH_STORE_DIR = join(here, "..", "data", "mesh-store");
/** Fallback invite location if not passed on argv (the hub writes its own copy). */
export const INVITE_FILE = join(here, "..", "data", "invite.txt");
/** Persisted set of node ids already embedded into EDGE_WORKSPACE. */
export const EMBEDDED_IDS_FILE = join(here, "..", "data", "embedded-ids.json");
/** The edge's vector workspace. */
export const EDGE_WORKSPACE = "mycelium-edge";
/** Where the edge writes its audit JSONL. */
export const LOG_DIR = join(here, "..", "logs");
