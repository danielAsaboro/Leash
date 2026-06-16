/**
 * Skills (server-only) — instruction documents the assistant loads on demand,
 * agentskills.io-spec-shaped. A skill is a FOLDER:
 *
 *   data/leash-skills/<slug>/SKILL.md         ← frontmatter (name/description/enabled/…) + body
 *   data/leash-skills/<slug>/references/…     ← optional attachments (read_skill_file)
 *   data/leash-skills/<slug>/scripts/…        ← optional executable scripts (run_skill_script)
 *   data/leash-skills/<slug>/assets/…         ← optional templates/data files
 *
 * Nested attachment paths (≤3 segments, `safeRelPath`) are supported everywhere; legacy
 * flat `<slug>.md` files still READ correctly and MIGRATE to the folder shape on their
 * next save. Skills are SEPARATE from tools: a tool is executable; a skill is prose
 * (plus files) the model reads via `read_skill` when its description matches.
 *
 * ENABLE MODEL (Agent-Skills standard) — a skill is ENABLED unless its frontmatter says
 * `enabled: false`; an absent key ⇒ ON (the standard's default: skills are available, the
 * dashboard toggles one off by writing `enabled: false`). SECURITY: imported/dropped-in skills
 * are third-party prompt input (and may carry scripts), so the IMPORT flow writes `enabled: false`
 * to quarantine them for review — built-in/hand-authored skills ship enabled.
 *
 * The frontmatter parser is hand-rolled (no YAML dep): `key: value` lines with optional
 * single/double quotes, `>`/`|` block scalars (incl. `-` chomping), and UNKNOWN KEYS
 * round-tripped via `extras` so spec fields (`license`, `compatibility`, `allowed-tools`,
 * …) survive dashboard edits.
 */
import { readFile, writeFile, readdir, rm, mkdir, stat, realpath } from "node:fs/promises";
import { join, resolve, dirname, sep } from "node:path";
import { DATA_DIR } from "./json-store.ts";
import { parseFrontmatter, parseToolList, parseLineList } from "./frontmatter.ts";
import { parsePluginSlug } from "./plugin-manifest.ts";
import { PLUGINS_DIR, pluginEnabled, pluginSkills } from "./plugins-store.ts";

export const SKILLS_DIR = process.env["LEASH_SKILLS_DIR"] ?? join(DATA_DIR, "leash-skills");

export interface Skill {
  slug: string;
  name: string;
  description: string;
  enabled: boolean;
  /** The markdown instruction body (without frontmatter). */
  body: string;
  /**
   * Tool names this skill declares it needs (frontmatter `tools: [bash, run_command, …]`).
   * When the skill activates, the harness loads ONLY this toolset (progressive tool
   * disclosure — see agent.ts). Empty = inherit the route's default toolset.
   */
  tools: string[];
  /**
   * An ORDERED plan (frontmatter `steps:` block scalar, one sub-task per line). When present,
   * `run_skill` executes the skill as a DETERMINISTIC pipeline: the harness drives the steps in
   * order, the model does ONE sub-task per step (with earlier steps' results fed forward), and
   * the model never decides "am I done?". This is the fix for qwen3-4b's dependent-step failure —
   * the planning burden lives with the author, not the 4B (deterministic decomposition; see
   * skill-runner.ts). Empty = single-shot skill (the model free-runs the body).
   */
  steps: string[];
  /**
   * Example user utterances (frontmatter `examples:` block, one per line) that should route TO this
   * skill. The matcher embeds each and routes by MAX similarity to any utterance (semantic-router
   * style) — so a skill can be represented by several concrete phrasings, not just its one description.
   * This is what lets a SPECIFIC skill out-rank a broad sibling on the intent it's actually for. Empty
   * = the description alone represents the skill (existing behavior).
   */
  examples: string[];
  /**
   * Agent-Skills-standard `when_to_use:` — trigger phrases/contexts for when to invoke. Feeds the
   * matcher exactly like `examples:` (each line is a routing utterance), and is the standard's way to
   * express triggers (the Claude Code / agentskills.io format the dashboard's skills follow).
   */
  whenToUse: string;
  /** True for skills that ship with the app (frontmatter `builtin: true`) vs. user-created/imported. */
  builtin: boolean;
  /** Attachment paths relative to the skill folder (POSIX, e.g. `references/x.md`). */
  files: string[];
  /** Unknown frontmatter keys, round-tripped verbatim on save (spec fields survive edits). */
  extras: Record<string, string>;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** One path segment: starts alphanumeric (rejects dotfiles, `.`/`..`), sane charset. */
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,80}$/;
/** Attachment read cap — keeps a single tool result bounded. */
const FILE_CAP = 64 * 1024;
/** Recursive listing caps — a skill folder is small by design. */
const MAX_DEPTH = 3;
const MAX_FILES = 200;

/** "Trip planning!" → "trip-planning". */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * Validate a skill-relative path: ≤3 segments, each `SEGMENT_RE` (no dotfiles, no `..`,
 * no absolute/drive prefixes). Returns the normalized POSIX form, or null. Containment
 * is belt-and-braces re-checked at use sites via `resolve` + `realpath`.
 */
export function safeRelPath(p: string): string | null {
  const norm = p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").trim();
  if (!norm || norm.length > 200) return null;
  const segs = norm.split("/");
  if (segs.length > MAX_DEPTH) return null;
  for (const s of segs) if (!SEGMENT_RE.test(s)) return null;
  return segs.join("/");
}

/**
 * The absolute folder a skill lives in. A NAMESPACED plugin slug `<id>:<name>` resolves under
 * `PLUGINS_DIR/<id>/skills/<name>/` (the plugin is registered virtually — its skills are never
 * copied into SKILLS_DIR); every other slug is a user skill under `SKILLS_DIR/<slug>/`. This is
 * the slug dispatcher every read path (getSkill / containedPath / skillFiles / readSkillFile)
 * funnels through, so a plugin skill's files resolve + stay contained exactly like a user skill's.
 */
export function skillRoot(slug: string): string {
  const p = parsePluginSlug(slug);
  return p ? join(PLUGINS_DIR, p.id, "skills", p.name) : join(SKILLS_DIR, slug);
}

/** A slug the read paths accept: a user skill slug OR a namespaced plugin-skill slug. */
function isReadableSlug(slug: string): boolean {
  return SLUG_RE.test(slug) || parsePluginSlug(slug) !== null;
}

/**
 * Resolve `rel` under the skill folder with symlink containment: the resolved REAL path
 * (of the file, or of its nearest existing ancestor for to-be-created files) must stay
 * under the skill folder's real path. Null when it escapes.
 */
async function containedPath(slug: string, rel: string): Promise<string | null> {
  const root = skillRoot(slug);
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    return null; // no skill folder
  }
  // Walk up to the nearest EXISTING ancestor and realpath that (the file itself may not exist yet).
  let probe = abs;
  for (;;) {
    try {
      const real = await realpath(probe);
      const tail = abs.slice(probe.length); // "" when probe === abs
      const full = real + tail;
      return full === rootReal || full.startsWith(rootReal + sep) ? abs : null;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
  }
}

// ── Frontmatter ────────────────────────────────────────────────────────────────

const KNOWN_KEYS = new Set(["name", "description", "enabled"]);

// `parseFrontmatter` / `parseToolList` / `parseLineList` now live in the shared `frontmatter.ts`
// (lifted out so the agents store reuses the exact same YAML-subset parser — imported above).

/** Parse one SKILL.md: frontmatter + body. Null on bad shape. `enabled` absent ⇒ DISABLED. */
function parseSkill(slug: string, raw: string, files: string[]): Skill | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return null;
  const fields = parseFrontmatter(m[1] as string);
  const name = fields["name"];
  if (!name) return null;
  const extras: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) if (!KNOWN_KEYS.has(k)) extras[k] = v;
  return {
    slug,
    name,
    description: fields["description"] ?? "",
    // Agent-Skills standard: a skill is ENABLED unless explicitly turned off. Only `enabled: false`
    // disables (the dashboard writes that to toggle one off); absent ⇒ on. (Imported skills are
    // quarantined by the import flow writing `enabled: false`, not by an absent-key default.)
    enabled: fields["enabled"] !== "false",
    body: (m[2] as string).trim(),
    // Standard `allowed-tools:` is the tool list (legacy `tools:` still honored). `when_to_use:` and
    // `examples:` both feed the matcher. All round-tripped via `extras` (not KNOWN_KEYS) and surfaced parsed.
    tools: parseToolList(fields["allowed-tools"] ?? fields["tools"]),
    steps: parseLineList(fields["steps"], 12),
    examples: parseLineList(fields["examples"], 12),
    whenToUse: fields["when_to_use"] ?? "",
    builtin: fields["builtin"] === "true",
    files,
    extras,
  };
}

function serializeSkill(s: { name: string; description: string; enabled: boolean; body: string; extras?: Record<string, string> }): string {
  const oneLine = (v: string): string => v.replace(/\s+/g, " ").trim();
  let fm = `name: ${oneLine(s.name)}\ndescription: ${oneLine(s.description)}\nenabled: ${s.enabled}\n`;
  for (const [k, v] of Object.entries(s.extras ?? {})) {
    if (KNOWN_KEYS.has(k) || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(k)) continue;
    fm += v.includes("\n") ? `${k}: |\n${v.split("\n").map((l) => `  ${l}`).join("\n")}\n` : `${k}: ${v}\n`;
  }
  return `---\n${fm}---\n\n${s.body.trim()}\n`;
}

// ── Listing / loading ──────────────────────────────────────────────────────────

/**
 * Attachment paths inside a skill folder `absRoot`, recursive to depth 3 (everything but the root
 * SKILL.md; no dotfiles), sorted relative POSIX paths (`references/x.md`, `scripts/y.sh`).
 */
async function skillFilesIn(absRoot: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(join(absRoot, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.name.startsWith(".")) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (p !== "SKILL.md") out.push(p);
    }
  };
  await walk("", 1);
  return out.sort();
}

/**
 * Read + parse one skill from an ABSOLUTE folder (folder shape only — no legacy flat fallback).
 * The single skill-folder reader, shared by `getSkill` (both user + plugin skills via the slug
 * dispatcher) and the plugin surfacer. `enabled` reflects the SKILL.md frontmatter; plugin
 * callers OVERRIDE it with the owning plugin's bit.
 */
export async function loadSkillFromDir(absDir: string, slug: string): Promise<Skill | null> {
  let raw: string;
  try {
    raw = await readFile(join(absDir, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
  return parseSkill(slug, raw, await skillFilesIn(absDir));
}

/**
 * Load one skill by slug. A NAMESPACED plugin slug (`<id>:<name>`) resolves under the plugin tree
 * and has its `enabled` driven by the plugin's registry row (so disabling the plugin disables its
 * skill everywhere `getSkill` is consulted — run_skill, read_skill, …). A user slug reads the
 * folder shape first, then the legacy flat `<slug>.md`.
 */
export async function getSkill(slug: string): Promise<Skill | null> {
  const plugin = parsePluginSlug(slug);
  if (plugin) {
    const skill = await loadSkillFromDir(skillRoot(slug), slug);
    return skill ? { ...skill, enabled: await pluginEnabled(plugin.id) } : null;
  }
  if (!SLUG_RE.test(slug)) return null;
  const folder = await loadSkillFromDir(join(SKILLS_DIR, slug), slug);
  if (folder) return folder;
  try {
    return parseSkill(slug, await readFile(join(SKILLS_DIR, `${slug}.md`), "utf8"), []);
  } catch {
    return null;
  }
}

/**
 * All skills, name-sorted — the user's own skills (folder + legacy flat shapes under SKILLS_DIR)
 * CONCATENATED with the virtual skills of installed plugins (`pluginSkills()`, namespaced
 * `<id>:<name>`, enabled driven by the plugin row). The `:` namespace guarantees no slug collision.
 * `[]` when nothing is installed.
 */
export async function listSkills(): Promise<Skill[]> {
  let entries: string[] = [];
  try {
    entries = await readdir(SKILLS_DIR);
  } catch {
    /* no user skills dir yet — plugin skills may still exist */
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
  const [user, plugins] = await Promise.all([Promise.all([...slugs].map((slug) => getSkill(slug))), pluginSkills()]);
  return [...user.filter((s): s is Skill => s !== null), ...plugins].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Create or replace a skill; slug defaults to slugify(name). Always writes the FOLDER
 * shape; a legacy flat file under the same slug is removed (the migration). `extras`
 * round-trips unknown frontmatter (pass the loaded skill's extras through on edits).
 */
export async function saveSkill(input: { slug?: string; name: string; description: string; enabled: boolean; body: string; extras?: Record<string, string> }): Promise<Skill> {
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
  return { slug, name: input.name.trim(), description: input.description.trim(), enabled: input.enabled, body: input.body, tools: parseToolList(input.extras?.["allowed-tools"] ?? input.extras?.["tools"]), steps: parseLineList(input.extras?.["steps"], 12), examples: parseLineList(input.extras?.["examples"], 12), whenToUse: input.extras?.["when_to_use"] ?? "", builtin: input.extras?.["builtin"] === "true", files: await skillFilesIn(join(SKILLS_DIR, slug)), extras: input.extras ?? {} };
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

// ── Import (zip → skill folder) ────────────────────────────────────────────────

/**
 * Import a skill from extracted zip entries (the route unzips + strips the common root +
 * enforces size/count caps). Requires exactly one root `SKILL.md` with a `name`; every
 * other entry must pass `safeRelPath`. The skill lands DISABLED regardless of what the
 * zip claims (review-then-enable posture). Throws with `code: "exists"` on a slug clash.
 */
export async function importSkill(entries: Array<{ path: string; data: Uint8Array }>): Promise<Skill> {
  const manifest = entries.find((e) => e.path === "SKILL.md");
  if (!manifest) throw new Error("the zip has no root SKILL.md");
  const rawManifest = Buffer.from(manifest.data).toString("utf8");
  const parsed = parseSkill("import", rawManifest, []);
  if (!parsed) throw new Error("SKILL.md is malformed (needs `---` frontmatter with a `name:`)");
  const slug = slugify(parsed.name);
  if (!SLUG_RE.test(slug)) throw new Error(`the skill name "${parsed.name}" doesn't make a valid slug`);
  if (await getSkill(slug)) {
    const err = new Error(`a skill "${slug}" already exists — delete it first to re-import`);
    (err as Error & { code?: string }).code = "exists";
    throw err;
  }
  // Validate every attachment path BEFORE writing anything.
  const files: Array<{ rel: string; data: Uint8Array }> = [];
  for (const e of entries) {
    if (e.path === "SKILL.md") continue;
    const rel = safeRelPath(e.path);
    if (!rel || rel === "SKILL.md") throw new Error(`unsafe path in zip: "${e.path}"`);
    files.push({ rel, data: e.data });
  }
  // SKILL.md is rewritten through the serializer with enabled forced FALSE (extras kept).
  await saveSkill({ slug, name: parsed.name, description: parsed.description, enabled: false, body: parsed.body, extras: parsed.extras });
  for (const f of files) {
    const abs = await containedPath(slug, f.rel);
    if (!abs) throw new Error(`unsafe path in zip: "${f.rel}"`);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, f.data);
  }
  const skill = await getSkill(slug);
  if (!skill) throw new Error("import failed — the written skill did not read back");
  return skill;
}

// ── Attachments ────────────────────────────────────────────────────────────────

/** Read one attachment as text (64 KB cap; nested paths ok). Honest message for binary content.
 *  Accepts a user slug OR a namespaced plugin-skill slug (read path — the dispatcher resolves the root). */
export async function readSkillFile(slug: string, file: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const rel = safeRelPath(file);
  if (!isReadableSlug(slug) || !rel || rel === "SKILL.md") return { ok: false, error: `invalid file path "${file}"` };
  const abs = await containedPath(slug, rel);
  if (!abs) return { ok: false, error: `invalid file path "${file}"` };
  let buf: Buffer;
  try {
    buf = await readFile(abs);
  } catch {
    return { ok: false, error: `the skill "${slug}" has no file "${rel}"` };
  }
  if (buf.subarray(0, 8000).includes(0)) return { ok: false, error: `"${rel}" is a binary file (${buf.length} bytes) — only text attachments can be read` };
  const text = buf.toString("utf8");
  return { ok: true, text: text.length > FILE_CAP ? text.slice(0, FILE_CAP) + `\n…(truncated at 64 KB of ${text.length} chars)` : text };
}

/** Create/replace one text attachment (nested paths ok — parents are created). */
export async function writeSkillFile(slug: string, file: string, content: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const rel = safeRelPath(file);
  if (!SLUG_RE.test(slug) || !rel || rel === "SKILL.md") return { ok: false, error: `invalid file path "${file}"` };
  const skill = await getSkill(slug);
  if (!skill) return { ok: false, error: `no skill "${slug}"` };
  // Ensure the folder shape (migrates a legacy flat skill on first attachment).
  await saveSkill({ slug, name: skill.name, description: skill.description, enabled: skill.enabled, body: skill.body, extras: skill.extras });
  const abs = await containedPath(slug, rel);
  if (!abs) return { ok: false, error: `invalid file path "${file}"` };
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
  return { ok: true };
}

/** Delete one attachment (nested paths ok; no-op if absent). */
export async function deleteSkillFile(slug: string, file: string): Promise<void> {
  const rel = safeRelPath(file);
  if (!SLUG_RE.test(slug) || !rel || rel === "SKILL.md") return;
  const abs = await containedPath(slug, rel);
  if (!abs) return;
  try {
    await rm(abs);
  } catch {
    /* already gone */
  }
}
