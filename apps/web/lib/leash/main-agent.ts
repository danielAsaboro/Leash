// apps/web/lib/leash/main-agent.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { splitFrontmatter } from "@mycelium/leash-core/frontmatter";
import { DEFAULT_LEASH_SYSTEM } from "./leash-defaults.ts";

export interface MainAgentBase {
  body: string;
  model: string;
  name: string;
}

const FALLBACK: MainAgentBase = { body: DEFAULT_LEASH_SYSTEM, model: "", name: "Leash" };

const here = dirname(fileURLToPath(import.meta.url));
// apps/web/lib/leash → apps/web/builtin-agents/leash.md
const DEFAULT_LEASH_MD = join(here, "..", "..", "builtin-agents", "leash.md");

/**
 * Load the static base (prompt + model + name) for the main Leash agent from leash.md.
 * Never throws — any failure returns the hardcoded constant fallback.
 * @param mdPath - override the file path (used by tests; omit in production)
 */
export function loadMainAgentBase(mdPath?: string): MainAgentBase {
  try {
    const raw = readFileSync(mdPath ?? DEFAULT_LEASH_MD, "utf8");
    const parsed = splitFrontmatter(raw);
    if (!parsed) return FALLBACK;
    const { fields, body } = parsed;
    const trimmedBody = body.trim();
    return {
      body: trimmedBody || FALLBACK.body,
      model: (fields["model"] ?? "").trim(),
      name: (fields["name"] ?? "").trim() || FALLBACK.name,
    };
  } catch {
    return FALLBACK;
  }
}
