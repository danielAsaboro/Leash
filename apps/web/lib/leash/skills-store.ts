/**
 * Skills (server-only) — instruction documents the assistant loads on demand,
 * Claude-skills-style. A skill is a FOLDER:
 *
 *   data/leash-skills/<slug>/SKILL.md     ← frontmatter (name/description/enabled) + body
 *   data/leash-skills/<slug>/<anything>   ← optional attachments (reference tables,
 *                                            templates, …) loaded via read_skill_file
 *
 * Legacy flat `<slug>.md` files still READ correctly and MIGRATE to the folder shape on
 * their next save. Skills are SEPARATE from tools: a tool is executable; a skill is
 * prose (plus files) the model reads via `read_skill` when its description matches the
 * request (`skill-tools.ts`). The frontmatter parser is hand-rolled — three known
 * string/boolean fields, no YAML dependency.
 */
import "server-only";
import { readFile, writeFile, readdir, rm, mkdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { DATA_DIR } from "./json-store.ts";

export const SKILLS_DIR = process.env["LEASH_SKILLS_DIR"] ?? join(DATA_DIR, "leash-skills");

export interface Skill {
  slug: string;
  name: string;
  description: string;
  enabled: boolean;
  /** The markdown instruction body (without frontmatter). */
  body: string;
  /** Attachment filenames (folder siblings of SKILL.md). */
  files: string[];
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,80}$/;
/** Attachment read cap — keeps a single tool result bounded. */
const FILE_CAP = 64 * 1024;

/** "Trip planning!" → "trip-planning". */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** Parse one SKILL.md: `--- key: value ---` frontmatter + body. Null on bad shape. */
function parseSkill(slug: string, raw: string, files: string[]): Skill | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return null;
  const fields: Record<string, string> = {};
  for (const line of (m[1] as string).split(/\r?\n/)) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line.trim());
    if (kv) fields[(kv[1] as string).toLowerCase()] = (kv[2] as string).trim();
  }
  const name = fields["name"];
  if (!name) return null;
  return {
    slug,
    name,
    description: fields["description"] ?? "",
    enabled: fields["enabled"] !== "false",
    body: (m[2] as string).trim(),
    files,
  };
}

function serializeSkill(s: { name: string; description: string; enabled: boolean; body: string }): string {
  const oneLine = (v: string): string => v.replace(/\s+/g, " ").trim();
  return `---\nname: ${oneLine(s.name)}\ndescription: ${oneLine(s.description)}\nenabled: ${s.enabled}\n---\n\n${s.body.trim()}\n`;
}

/** Attachment filenames inside a skill folder (everything but SKILL.md, no dotfiles). */
async function skillFiles(slug: string): Promise<string[]> {
  try {
    return (await readdir(join(SKILLS_DIR, slug))).filter((f) => f !== "SKILL.md" && !f.startsWith(".")).sort();
  } catch {
    return [];
  }
}

/** Load one skill by slug — folder shape first, then legacy flat `<slug>.md`. */
export async function getSkill(slug: string): Promise<Skill | null> {
  if (!SLUG_RE.test(slug)) return null;
  try {
    const raw = await readFile(join(SKILLS_DIR, slug, "SKILL.md"), "utf8");
    return parseSkill(slug, raw, await skillFiles(slug));
  } catch {
    /* fall through to legacy flat file */
  }
  try {
    return parseSkill(slug, await readFile(join(SKILLS_DIR, `${slug}.md`), "utf8"), []);
  } catch {
    return null;
  }
}

/** All skills, name-sorted (`[]` when the directory doesn't exist yet). Both shapes. */
export async function listSkills(): Promise<Skill[]> {
  let entries: string[];
  try {
    entries = await readdir(SKILLS_DIR);
  } catch {
    return [];
  }
  const slugs = new Set<string>();
  for (const e of entries) {
    if (e.startsWith(".")) continue;
    if (e.endsWith(".md")) slugs.add(e.replace(/\.md$/, ""));
    else {
      try {
        if ((await stat(join(SKILLS_DIR, e))).isDirectory()) slugs.add(e);
      } catch {
        /* raced */
      }
    }
  }
  const skills = await Promise.all([...slugs].map((slug) => getSkill(slug)));
  return skills.filter((s): s is Skill => s !== null).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Create or replace a skill; slug defaults to slugify(name). Always writes the FOLDER
 * shape; a legacy flat file under the same slug is removed (the migration).
 */
export async function saveSkill(input: { slug?: string; name: string; description: string; enabled: boolean; body: string }): Promise<Skill> {
  const slug = input.slug?.trim() || slugify(input.name);
  if (!SLUG_RE.test(slug)) throw new Error(`invalid skill slug "${slug}"`);
  if (!input.name.trim()) throw new Error("skill name is required");
  await mkdir(join(SKILLS_DIR, slug), { recursive: true });
  await writeFile(join(SKILLS_DIR, slug, "SKILL.md"), serializeSkill({ ...input, name: input.name.trim(), description: input.description.trim() }));
  try {
    await rm(join(SKILLS_DIR, `${slug}.md`)); // migrate away the legacy flat file
  } catch {
    /* none existed */
  }
  return { slug, name: input.name.trim(), description: input.description.trim(), enabled: input.enabled, body: input.body, files: await skillFiles(slug) };
}

/** Delete a skill — folder and/or legacy flat file (no-op if already gone). */
export async function deleteSkill(slug: string): Promise<void> {
  if (!SLUG_RE.test(slug)) return;
  try {
    await rm(join(SKILLS_DIR, slug), { recursive: true });
  } catch {
    /* no folder */
  }
  try {
    await rm(join(SKILLS_DIR, `${slug}.md`));
  } catch {
    /* no flat file */
  }
}

// ── Attachments ────────────────────────────────────────────────────────────────

/** Read one attachment as text (64 KB cap). Honest message for binary content. */
export async function readSkillFile(slug: string, file: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const name = basename(file);
  if (!SLUG_RE.test(slug) || !FILE_RE.test(name) || name === "SKILL.md") return { ok: false, error: `invalid file name "${file}"` };
  let buf: Buffer;
  try {
    buf = await readFile(join(SKILLS_DIR, slug, name));
  } catch {
    return { ok: false, error: `the skill "${slug}" has no file "${name}"` };
  }
  if (buf.subarray(0, 8000).includes(0)) return { ok: false, error: `"${name}" is a binary file (${buf.length} bytes) — only text attachments can be read` };
  const text = buf.toString("utf8");
  return { ok: true, text: text.length > FILE_CAP ? text.slice(0, FILE_CAP) + `\n…(truncated at 64 KB of ${text.length} chars)` : text };
}

/** Create/replace one text attachment. The skill must exist (folder shape enforced). */
export async function writeSkillFile(slug: string, file: string, content: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const name = basename(file);
  if (!SLUG_RE.test(slug) || !FILE_RE.test(name) || name === "SKILL.md") return { ok: false, error: `invalid file name "${file}"` };
  const skill = await getSkill(slug);
  if (!skill) return { ok: false, error: `no skill "${slug}"` };
  // Ensure the folder shape (migrates a legacy flat skill on first attachment).
  await saveSkill({ slug, name: skill.name, description: skill.description, enabled: skill.enabled, body: skill.body });
  await writeFile(join(SKILLS_DIR, slug, name), content);
  return { ok: true };
}

/** Delete one attachment (no-op if absent). */
export async function deleteSkillFile(slug: string, file: string): Promise<void> {
  const name = basename(file);
  if (!SLUG_RE.test(slug) || !FILE_RE.test(name) || name === "SKILL.md") return;
  try {
    await rm(join(SKILLS_DIR, slug, name));
  } catch {
    /* already gone */
  }
}
