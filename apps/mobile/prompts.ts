/**
 * Editable prompt overrides — the mobile analogue of the desktop prompts-store. The defaults are
 * the exact constants the chat used before this store existed; an override edited in Brain → Prompts
 * is loaded on mount and composed into the live chat system message (App.tsx → buildSystem), so the
 * tab genuinely changes how Leash answers. One JSON file in the app's document directory.
 */
import * as FileSystem from "expo-file-system/legacy";

export type PromptKey = "system" | "voice";

/** Base identity for every turn — ported verbatim from the original App.tsx LEASH_SYSTEM. */
export const DEFAULT_SYSTEM =
  "You are Leash, a private assistant that runs entirely on this device — nothing leaves for the cloud. " +
  "Answer concisely and conversationally in plain prose. Don't pad or over-explain; if you don't know, say so plainly.";

/** Appended on spoken turns — ported verbatim from the original App.tsx VOICE_DIRECTIVE. */
export const DEFAULT_VOICE =
  " This reply will be spoken aloud by a text-to-speech voice. Answer in at most two short sentences of plain spoken prose. " +
  "Never use markdown, lists, code blocks, headings, links, or emoji — say 'first… then… finally…' instead of bullets.";

export const PROMPT_META: { key: PromptKey; label: string; hint: string; def: string }[] = [
  { key: "system", label: "System prompt", hint: "Leash's base identity, prepended to every turn.", def: DEFAULT_SYSTEM },
  { key: "voice", label: "Voice directive", hint: "Appended on spoken turns so replies stay short and markdown-free.", def: DEFAULT_VOICE },
];

export type Prompts = { system: string; voice: string };

const FILE = `${FileSystem.documentDirectory}prompts.json`;

type Overrides = Partial<Record<PromptKey, string>>;

async function readOverrides(): Promise<Overrides> {
  try {
    const info = await FileSystem.getInfoAsync(FILE);
    if (!info.exists) return {};
    return (JSON.parse(await FileSystem.readAsStringAsync(FILE)) as Overrides) ?? {};
  } catch {
    return {};
  }
}

async function writeOverrides(o: Overrides): Promise<void> {
  try {
    await FileSystem.writeAsStringAsync(FILE, JSON.stringify(o));
  } catch {
    /* best-effort */
  }
}

const defaultFor = (key: PromptKey): string => (key === "system" ? DEFAULT_SYSTEM : DEFAULT_VOICE);

/** Effective prompts — the override if present, otherwise the code default. */
export async function getPrompts(): Promise<Prompts> {
  const o = await readOverrides();
  return { system: o.system ?? DEFAULT_SYSTEM, voice: o.voice ?? DEFAULT_VOICE };
}

/** Is this key currently overridden (differs from the code default)? */
export async function isOverridden(key: PromptKey): Promise<boolean> {
  const o = await readOverrides();
  return typeof o[key] === "string";
}

export async function setPrompt(key: PromptKey, value: string): Promise<void> {
  const o = await readOverrides();
  const v = value.trim();
  if (!v || v === defaultFor(key)) delete o[key];
  else o[key] = v;
  await writeOverrides(o);
}

export async function resetPrompt(key: PromptKey): Promise<void> {
  const o = await readOverrides();
  delete o[key];
  await writeOverrides(o);
}
