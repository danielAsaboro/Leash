/**
 * Leash prompt overrides (server-only) — `data/leash-prompts.json`.
 *
 * Stores OVERRIDES ONLY for editable capability prompts (`chat`, `voice`, `health`);
 * `null`/absent = use the code default from `prompt.ts`. Other runtime prompt builders
 * also live in `prompt.ts`. Reads are mtime-cached, so the chat route's per-turn
 * `getPrompt` costs a `stat` — and hand-edits to the JSON are honored without a restart.
 */
import "server-only";
import { join } from "node:path";
import { readJsonCached, writeJson, invalidateJsonCache, DATA_DIR } from "./json-store.ts";
import { CHAT_SYSTEM_PROMPT, HEALTH_SPECIALIST_PROMPT, VOICE_RESPONSE_PROMPT } from "./prompt.ts";

export const PROMPTS_FILE = process.env["LEASH_PROMPTS_FILE"] ?? join(DATA_DIR, "leash-prompts.json");

export type PromptKey = "chat" | "voice" | "health";
export const PROMPT_KEYS: readonly PromptKey[] = ["chat", "voice", "health"];

const DEFAULTS: Record<PromptKey, string> = {
  chat: CHAT_SYSTEM_PROMPT,
  voice: VOICE_RESPONSE_PROMPT,
  health: HEALTH_SPECIALIST_PROMPT,
};

/** Human labels + what each capability prompt does (for the editor UI). */
export const PROMPT_META: Record<PromptKey, { label: string; hint: string }> = {
  chat: { label: "Chat prompt", hint: "The assistant's base instructions on chat turns (skills, grounding, tone)." },
  voice: { label: "Voice response prompt", hint: "Appended on spoken turns only — keeps replies short and markdown-free for TTS." },
  health: { label: "Health specialist prompt", hint: "Appended on health, medical, medication, and wellbeing turns." },
};

type Overrides = Partial<Record<PromptKey, string>>;

async function loadOverrides(): Promise<Overrides> {
  const raw = await readJsonCached<Record<string, unknown>>(PROMPTS_FILE, {});
  if (!raw || typeof raw !== "object") return {};
  return Object.fromEntries(PROMPT_KEYS.flatMap((key) => {
    const value = raw[key];
    return typeof value === "string" && value.trim() ? [[key, value] as const] : [];
  })) as Overrides;
}

/** The effective prompt text for a key — override ?? code default. */
export async function getPrompt(key: PromptKey, fallback?: string): Promise<string> {
  const o = (await loadOverrides())[key];
  return o ?? (fallback ?? DEFAULTS[key]);
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
    const overridden = typeof o === "string";
    return { key, ...PROMPT_META[key], value: overridden ? o : DEFAULTS[key], defaultValue: DEFAULTS[key], overridden };
  });
}

/** Set (non-empty string) or clear (null/empty) one prompt's override. */
export async function setPrompt(key: PromptKey, value: string | null): Promise<void> {
  if (!PROMPT_KEYS.includes(key)) throw new Error(`unknown prompt key "${key}"`);
  const overrides = { ...(await loadOverrides()) };
  if (typeof value === "string" && value.trim()) {
    overrides[key] = value;
  } else {
    delete overrides[key];
  }
  await writeJson(PROMPTS_FILE, overrides);
  invalidateJsonCache(PROMPTS_FILE);
}
