/**
 * Frontmatter parsing — shared, pure, isomorphic (NO `server-only`, NO `node:*`).
 *
 * Lifted verbatim out of `skills-store.ts` (which kept a hand-rolled YAML-subset parser to
 * avoid a YAML dep) so the agents store can reuse the exact same `key: value` / block-scalar /
 * quoting behavior. Both Claude-Code skills AND agents are `---`-frontmatter markdown, so they
 * share one parser. Keep this dependency-free: it is imported by stores AND (potentially) the
 * client validation path, exactly like `mcp-config.ts`.
 *
 * Supports: `key: value` lines (optional single/double quotes), `>`/`|` block scalars
 * (`>` folds with spaces, `|` keeps newlines; `-` chomping accepted), and round-trips unknown
 * keys to the caller (callers decide which keys are "known"). Indented lines never start a new
 * key (block content only).
 */

/**
 * Parse `--- … ---` frontmatter lines into a flat `key → value` map. Block scalars and quoted
 * strings are unwrapped; keys are lowercased. Lines that aren't `key:`-shaped are ignored.
 */
export function parseFrontmatter(src: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(lines[i] as string);
    if (!kv) continue;
    const key = (kv[1] as string).toLowerCase();
    let val = (kv[2] as string).trim();
    if (/^[>|]-?$/.test(val)) {
      const fold = val.startsWith(">");
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1] as string) || (lines[i + 1] as string).trim() === "")) {
        i++;
        block.push((lines[i] as string).trim());
      }
      while (block.length > 0 && block[block.length - 1] === "") block.pop();
      val = block.join(fold ? " " : "\n").trim();
    } else if (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    fields[key] = val;
  }
  return fields;
}

/**
 * Split one `---`-frontmatter markdown document into `{ fields, body }`. Returns null when the
 * document has no `--- … ---` block (the same shape `parseSkill`/`parseAgent` require). `body` is
 * trimmed; `fields` is `parseFrontmatter` over the block.
 */
export function splitFrontmatter(raw: string): { fields: Record<string, string>; body: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return null;
  return { fields: parseFrontmatter(m[1] as string), body: (m[2] as string).trim() };
}

/**
 * Parse a `tools:` frontmatter value into a clean tool-name list. Accepts both the `[a, b, c]`
 * array form and a bare `a, b, c` (comma/space-separated) string; strips brackets/quotes and keeps
 * only tool-name-shaped tokens (so prose can't smuggle in junk).
 */
export function parseToolList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .replace(/^\s*\[/, "")
    .replace(/\]\s*$/, "")
    .split(/[\s,]+/)
    .map((t) => t.trim().replace(/^["']|["']$/g, ""))
    .filter((t) => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(t));
}

/**
 * Parse a block-scalar value into a clean line list — one item per line, any leading list marker
 * (`- `, `* `, `1. `) stripped, blanks dropped, bounded to `cap`. Used for `steps:`/`examples:`
 * (skills) and any other multi-line frontmatter list. The block value is produced by the `|`/`>`
 * frontmatter parser above.
 */
export function parseLineList(raw: string | undefined, cap: number): string[] {
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim())
    .filter((l) => l.length > 0)
    .slice(0, cap);
}
