// No 'server-only' guard here: this module is imported by scripts/main-agent.test.ts (tsx, outside Next.js), where 'server-only' would throw. It only ever does read-only fs access.
// apps/web/lib/leash/main-agent.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { splitFrontmatter } from "@mycelium/leash-core/frontmatter";
import { CHAT_SYSTEM_PROMPT } from "./prompt.ts";

export interface MainAgentBase {
  body: string;
  model: string;
  name: string;
}

const FALLBACK: MainAgentBase = { body: CHAT_SYSTEM_PROMPT, model: "", name: "Leash" };

const here = dirname(fileURLToPath(import.meta.url));
// In the packaged standalone build the bundled route module can't resolve the source tree, so
// server-launch.mjs injects LEASH_BUILTIN_AGENTS_DIR. Dev/tsx/tests fall back to the source-relative
// path (apps/web/lib/leash → apps/web/builtin-agents).
const BUILTIN_AGENTS_DIR = process.env["LEASH_BUILTIN_AGENTS_DIR"] ?? join(here, "..", "..", "builtin-agents");
const BUILTIN_LEASH_AGENT_MD = join(BUILTIN_AGENTS_DIR, "leash.md");

/**
 * Load the static base (prompt + model + name) for the main Leash agent from leash.md.
 * Never throws — any failure returns the hardcoded constant fallback.
 * @param mdPath - override the file path (used by tests; omit in production)
 */
export function loadMainAgentBase(mdPath?: string): MainAgentBase {
  try {
    const raw = readFileSync(mdPath ?? BUILTIN_LEASH_AGENT_MD, "utf8");
    const parsed = splitFrontmatter(raw);
    if (!parsed) return { ...FALLBACK };
    const { fields, body } = parsed;
    const trimmedBody = body.trim();
    return {
      body: trimmedBody || FALLBACK.body,
      model: (fields["model"] ?? "").trim(),
      name: (fields["name"] ?? "").trim() || FALLBACK.name,
    };
  } catch {
    return { ...FALLBACK };
  }
}
