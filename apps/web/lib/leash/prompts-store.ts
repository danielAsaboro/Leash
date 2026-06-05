/**
 * Leash prompt overrides (server-only) — `data/leash-prompts.json`.
 *
 * Stores OVERRIDES ONLY for the three Leash prompts (`system`, `voice`, `medpsy`);
 * `null`/absent = use the code default from `tools.ts`. Council/newsroom prompts stay
 * in code by design. Reads are mtime-cached, so the chat route's per-turn `getPrompt`
 * costs a `stat` — and hand-edits to the JSON are honored without a restart.
 */
import "server-only";
import { join } from "node:path";
import { readJsonCached, writeJson, invalidateJsonCache, DATA_DIR } from "./json-store.ts";
import { DEFAULT_LEASH_SYSTEM, DEFAULT_LEASH_VOICE_DIRECTIVE, DEFAULT_MEDPSY_SUFFIX } from "./tools.ts";

export const PROMPTS_FILE = process.env["LEASH_PROMPTS_FILE"] ?? join(DATA_DIR, "leash-prompts.json");

export type PromptKey = "system" | "voice" | "medpsy";
export const PROMPT_KEYS: readonly PromptKey[] = ["system", "voice", "medpsy"];

const DEFAULTS: Record<PromptKey, string> = {
  system: DEFAULT_LEASH_SYSTEM,
  voice: DEFAULT_LEASH_VOICE_DIRECTIVE,
  medpsy: DEFAULT_MEDPSY_SUFFIX,
};

/** Human labels + what each prompt does (for the editor UI). */
export const PROMPT_META: Record<PromptKey, { label: string; hint: string }> = {
  system: { label: "System prompt", hint: "The assistant's base instructions on every turn (tools, grounding, tone)." },
  voice: { label: "Voice directive", hint: "Appended on spoken turns only — keeps replies short and markdown-free for TTS." },
  medpsy: { label: "MedPsy suffix", hint: "Appended when a turn routes to the MedPsy medical specialist." },
};

type Overrides = Partial<Record<PromptKey, string | null>>;

async function loadOverrides(): Promise<Overrides> {
  const raw = await readJsonCached<Overrides>(PROMPTS_FILE, {});
  return raw && typeof raw === "object" ? raw : {};
}

/** The effective prompt text for a key — override ?? code default. */
export async function getPrompt(key: PromptKey): Promise<string> {
  const o = (await loadOverrides())[key];
  return typeof o === "string" && o.trim() ? o : DEFAULTS[key];
}

export interface PromptView {
  key: PromptKey;
  label: string;
  hint: string;
  /** The effective text the model sees. */
  value: string;
  /** The code default (for the "reset" affordance + diffing). */
  defaultValue: string;
  overridden: boolean;
}

/** All three prompts with override state — the editor's read model. */
export async function getPrompts(): Promise<PromptView[]> {
  const overrides = await loadOverrides();
  return PROMPT_KEYS.map((key) => {
    const o = overrides[key];
    const overridden = typeof o === "string" && o.trim().length > 0;
    return { key, ...PROMPT_META[key], value: overridden ? (o as string) : DEFAULTS[key], defaultValue: DEFAULTS[key], overridden };
  });
}

/** Set (non-empty string) or clear (null/empty) one prompt's override. */
export async function setPrompt(key: PromptKey, value: string | null): Promise<void> {
  if (!PROMPT_KEYS.includes(key)) throw new Error(`unknown prompt key "${key}"`);
  const overrides = { ...(await loadOverrides()) };
  if (typeof value === "string" && value.trim()) overrides[key] = value;
  else delete overrides[key];
  await writeJson(PROMPTS_FILE, overrides);
  invalidateJsonCache(PROMPTS_FILE);
}
