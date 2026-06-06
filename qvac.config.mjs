/**
 * Machine-neutral qvac config — the file the qvac CLI and SDK actually load.
 *
 * The real config DATA lives in `qvac.config.base.json` (plain JSON so Leash's
 * dashboard can keep editing it programmatically); this wrapper expands a leading
 * `~/` in every string value to THIS machine's home dir. That keeps absolute
 * per-machine paths (`/Users/cartel/...` vs `/Users/MAC/...`) out of the synced
 * tree — both Macs share one identical config.
 *
 * Load order trivia (why the base file must NOT be named `qvac.config.json`):
 * the CLI tries `.json` BEFORE `.mjs`, the SDK tries `.mjs` BEFORE `.json` — a
 * leftover `qvac.config.json` next to this file would shadow it for the CLI.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const expand = (v) => (typeof v === "string" && v.startsWith("~/") ? join(homedir(), v.slice(2)) : v);
const walk = (node) => {
  if (Array.isArray(node)) return node.map(walk);
  if (node !== null && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
  return expand(node);
};

export default walk(JSON.parse(readFileSync(join(here, "qvac.config.base.json"), "utf-8")));
