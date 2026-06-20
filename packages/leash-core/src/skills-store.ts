/**
 * Skills (server-only) — instruction documents the assistant loads on demand,
 * agentskills.io-spec-shaped. A skill is a FOLDER:
 *
 *   data/leash-skills/<slug>/SKILL.md         ← frontmatter (name/description/allowed-tools/…) + body
 *   data/leash-skills/<slug>/references/…     ← optional attachments (read_skill_file)
 *   data/leash-skills/<slug>/scripts/…        ← optional executable scripts (run_skill_script)
 *   data/leash-skills/<slug>/assets/…         ← optional templates/data files
 *
 * Nested attachment paths (≤3 segments, `safeRelPath`) are supported everywhere. Skills are
 * SEPARATE from tools: a tool is executable; a skill is prose (plus files) the model reads via
 * `read_skill` when its description matches.
 *
 * ENABLE MODEL — enabled/disabled is Leash app state, not Agent Skills frontmatter. A skill is
 * enabled unless `leash-skills-state.json` disables it. Imported skills land disabled in app state
 * for review; built-in/hand-authored skills ship enabled.
 *
 * The frontmatter parser is hand-rolled (no YAML dep): `key: value` lines with optional
 * single/double quotes and `>`/`|` block scalars (incl. `-` chomping). Unknown top-level keys
 * are rejected; supported standard/Claude fields round-trip via `extras`.
 */
import { readFile, writeFile, readdir, rm, mkdir, stat, realpath } from "node:fs/promises";
import { basename, join, resolve, dirname, sep } from "node:path";
import { DATA_DIR, invalidateJsonCache, readJsonCached, writeJson } from "./json-store.ts";
import { parseToolList, parseLineList, splitFrontmatter } from "./frontmatter.ts";
import { parsePluginSlug } from "./plugin-manifest.ts";
import { PLUGINS_DIR, pluginEnabled, pluginSkills } from "./plugins-store.ts";

export const SKILLS_DIR = process.env["LEASH_SKILLS_DIR"] ?? join(DATA_DIR, "leash-skills");
export const SKILLS_STATE_FILE = process.env["LEASH_SKILLS_STATE_FILE"] ?? join(DATA_DIR, "leash-skills-state.json");

export interface Skill {
  slug: string;
  name: string;
  description: string;
  enabled: boolean;
  /** The markdown instruction body (without frontmatter). */
  body: string;
  /**
   * Tool names this skill declares it needs (frontmatter `allowed-tools:`).
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
   * Leash routing examples stored under standard `metadata.examples`, not as a custom top-level
   * frontmatter field. These help separate nearby skills during automatic routing.
   */
  examples: string[];
  /**
   * Agent-Skills-standard `when_to_use:` — trigger phrases/contexts for when to invoke.
   */
  whenToUse: string;
  /** True for skills that ship with the app (`metadata.builtin: true`) vs. user-created/imported. */
  builtin: boolean;
  /** False hides the skill in user-facing menus while still allowing model activation. */
  userInvocable: boolean;
  /** True excludes the skill from automatic model activation and catalog prompts. */
  disableModelInvocation: boolean;
  /** Attachment paths relative to the skill folder (POSIX, e.g. `references/x.md`). */
  files: string[];
  /** Unknown frontmatter keys, round-tripped verbatim on save (spec fields survive edits). */
  extras: Record<string, string>;
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** One path segment: starts alphanumeric (rejects dotfiles, `.`/`..`), sane charset. */
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,80}$/;
/** Attachment read cap — keeps a single tool result bounded. */
const FILE_CAP = 64 * 1024;
/** Recursive listing caps — a skill folder is small by design. */
const MAX_DEPTH = 3;
const MAX_FILES = 200;

export function isValidSkillName(name: string): boolean {
  return name.length >= 1 && name.length <= 64 && SLUG_RE.test(name);
}

/** "Trip planning!" → "trip-planning". Used for plugin ids and other stores, not skill names. */
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
  return isValidSkillName(slug) || parsePluginSlug(slug) !== null;
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

const STANDARD_KEYS = ["name", "description", "license", "compatibility", "metadata", "allowed-tools"] as const;
const CLAUDE_EXTENSION_KEYS = [
  "when_to_use",
  "argument-hint",
  "arguments",
  "disable-model-invocation",
  "user-invocable",
  "disallowed-tools",
  "model",
  "effort",
  "context",
  "agent",
  "paths",
  "shell",
  "hooks",
] as const;
const LEASH_EXTENSION_KEYS = ["steps"] as const;
const KNOWN_KEYS = new Set<string>([...STANDARD_KEYS, ...CLAUDE_EXTENSION_KEYS, ...LEASH_EXTENSION_KEYS]);
const CORE_KEYS = new Set(["name", "description"]);

// `parseFrontmatter` / `parseToolList` / `parseLineList` now live in the shared `frontmatter.ts`
// (lifted out so the agents store reuses the exact same YAML-subset parser — imported above).

interface SkillsState {
  disabled?: string[];
}

async function readSkillsState(): Promise<SkillsState> {
  return (await readJsonCached<SkillsState>(SKILLS_STATE_FILE, {})) ?? {};
}

async function skillEnabled(slug: string): Promise<boolean> {
  return !new Set((await readSkillsState()).disabled ?? []).has(slug);
}

async function setSkillEnabled(slug: string, enabled: boolean): Promise<void> {
  const cfg = await readSkillsState();
  const disabled = new Set(cfg.disabled ?? []);
  if (enabled) disabled.delete(slug);
  else disabled.add(slug);
  await writeJson(SKILLS_STATE_FILE, { ...cfg, disabled: [...disabled].sort() });
  invalidateJsonCache(SKILLS_STATE_FILE);
}

function metadataObject(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return !!parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return Object.fromEntries(
      raw
        .split(/\r?\n/)
        .map((line) => /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.+)$/.exec(line.trim()))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => [m[1] as string, (m[2] as string).trim()]),
    );
  }
}

function metadataFlag(raw: string | undefined, key: string): boolean {
  const value = metadataObject(raw)[key];
  return value === true || value === "true";
}

function metadataExamples(raw: string | undefined): string[] {
  const value = metadataObject(raw)["examples"];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim()).slice(0, 12);
  if (typeof value === "string") return parseLineList(value, 12);
  return [];
}

/** Parse one SKILL.md: frontmatter + body. Null on invalid Agent Skills shape. */
function parseSkill(slug: string, folderName: string, raw: string, files: string[], enabled: boolean): Skill | null {
  const split = splitFrontmatter(raw);
  if (!split) return null;
  const fields = split.fields;
  for (const k of Object.keys(fields)) if (!KNOWN_KEYS.has(k)) return null;
  const name = fields["name"]?.trim() ?? "";
  if (!isValidSkillName(name) || name !== folderName) return null;
  const description = fields["description"]?.trim() ?? "";
  if (!description || description.length > 1024) return null;
  const extras: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) if (!CORE_KEYS.has(k)) extras[k] = v;
  return {
    slug,
    name,
    description,
    enabled,
    body: split.body,
    tools: parseToolList(fields["allowed-tools"]),
    steps: parseLineList(fields["steps"], 12),
    examples: metadataExamples(fields["metadata"]),
    whenToUse: fields["when_to_use"] ?? "",
    builtin: metadataFlag(fields["metadata"], "builtin"),
    userInvocable: fields["user-invocable"] !== "false",
    disableModelInvocation: fields["disable-model-invocation"] === "true",
    files,
    extras,
  };
}

function serializeSkill(s: { name: string; description: string; body: string; extras?: Record<string, string> }): string {
  const oneLine = (v: string): string => v.replace(/\s+/g, " ").trim();
  let fm = `name: ${oneLine(s.name)}\ndescription: ${oneLine(s.description)}\n`;
  for (const [k, v] of Object.entries(s.extras ?? {})) {
    if (CORE_KEYS.has(k) || !KNOWN_KEYS.has(k) || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(k)) continue;
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
 * dispatcher) and the plugin surfacer. User skills read enabled from app state; plugin callers
 * override it with the owning plugin's bit.
 */
export async function loadSkillFromDir(absDir: string, slug: string): Promise<Skill | null> {
  let raw: string;
  try {
    raw = await readFile(join(absDir, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
  const folderName = parsePluginSlug(slug)?.name ?? basename(absDir);
  return parseSkill(slug, folderName, raw, await skillFilesIn(absDir), await skillEnabled(slug));
}

/**
 * Load one skill by slug. A NAMESPACED plugin slug (`<id>:<name>`) resolves under the plugin tree
 * and has its `enabled` driven by the plugin's registry row (so disabling the plugin disables its
 * skill everywhere `getSkill` is consulted — run_skill, read_skill, …). A user slug reads the
 * folder shape only.
 */
export async function getSkill(slug: string): Promise<Skill | null> {
  const plugin = parsePluginSlug(slug);
  if (plugin) {
    const skill = await loadSkillFromDir(skillRoot(slug), slug);
    return skill ? { ...skill, enabled: await pluginEnabled(plugin.id) } : null;
  }
  if (!isValidSkillName(slug)) return null;
  return loadSkillFromDir(join(SKILLS_DIR, slug), slug);
}

/**
 * All skills, name-sorted — the user's own skill folders under SKILLS_DIR
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
    try {
      if ((await stat(join(SKILLS_DIR, e))).isDirectory()) slugs.add(e);
    } catch {
      /* raced */
    }
  }
  const [user, plugins] = await Promise.all([Promise.all([...slugs].map((slug) => getSkill(slug))), pluginSkills()]);
  return [...user.filter((s): s is Skill => s !== null), ...plugins].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Create or replace a skill. `name` must be the canonical folder slug; display names do not belong
 * in Agent Skills frontmatter.
 */
export async function saveSkill(input: { slug?: string; name: string; description: string; enabled: boolean; body: string; extras?: Record<string, string> }): Promise<Skill> {
  const slug = input.slug?.trim() || input.name.trim();
  if (!isValidSkillName(slug)) throw new Error("skill name must be lowercase hyphenated, 1-64 chars, with no spaces, uppercase, or repeated/edge hyphens");
  if (input.name.trim() !== slug) throw new Error(`skill name must exactly match its folder slug "${slug}"`);
  const description = input.description.trim();
  if (!description) throw new Error("skill description is required");
  if (description.length > 1024) throw new Error("skill description must be 1024 characters or fewer");
  for (const k of Object.keys(input.extras ?? {})) if (!KNOWN_KEYS.has(k)) throw new Error(`unsupported skill frontmatter field "${k}"`);
  await mkdir(join(SKILLS_DIR, slug), { recursive: true });
  await writeFile(join(SKILLS_DIR, slug, "SKILL.md"), serializeSkill({ name: slug, description, body: input.body, extras: input.extras }));
  await setSkillEnabled(slug, input.enabled);
  return {
    slug,
    name: slug,
    description,
    enabled: input.enabled,
    body: input.body,
    tools: parseToolList(input.extras?.["allowed-tools"]),
    steps: parseLineList(input.extras?.["steps"], 12),
    examples: metadataExamples(input.extras?.["metadata"]),
    whenToUse: input.extras?.["when_to_use"] ?? "",
    builtin: metadataFlag(input.extras?.["metadata"], "builtin"),
    userInvocable: input.extras?.["user-invocable"] !== "false",
    disableModelInvocation: input.extras?.["disable-model-invocation"] === "true",
    files: await skillFilesIn(join(SKILLS_DIR, slug)),
    extras: input.extras ?? {},
  };
}

/** Delete a skill folder (no-op if already gone). */
export async function deleteSkill(slug: string): Promise<void> {
  if (!isValidSkillName(slug)) return;
  try {
    await rm(join(SKILLS_DIR, slug), { recursive: true });
  } catch {
    /* no folder */
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
  const split = splitFrontmatter(rawManifest);
  const slug = split?.fields["name"]?.trim() ?? "";
  const parsed = slug ? parseSkill(slug, slug, rawManifest, [], false) : null;
  if (!parsed) throw new Error("SKILL.md is malformed (name must be lowercase hyphenated, match the package folder, and include a description)");
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
  // SKILL.md is rewritten through the serializer; enabled is stored in Leash app state.
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
  if (!isValidSkillName(slug) || !rel || rel === "SKILL.md") return { ok: false, error: `invalid file path "${file}"` };
  const skill = await getSkill(slug);
  if (!skill) return { ok: false, error: `no skill "${slug}"` };
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
  if (!isValidSkillName(slug) || !rel || rel === "SKILL.md") return;
  const abs = await containedPath(slug, rel);
  if (!abs) return;
  try {
    await rm(abs);
  } catch {
    /* already gone */
  }
}
