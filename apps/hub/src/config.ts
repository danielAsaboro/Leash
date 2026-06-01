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
/** The hub's persistent graph node log. */
export const GRAPH_FILE = join(here, "..", "data", "graph.jsonl");
/** The hub's vector workspace. */
export const HUB_WORKSPACE = "mycelium-hub";
/** Where the hub writes its audit JSONL. */
export const LOG_DIR = join(here, "..", "logs");
