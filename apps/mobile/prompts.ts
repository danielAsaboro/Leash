/**
 * Editable prompt overrides — the mobile analogue of the desktop prompts-store. The defaults are
 * the exact constants the chat used before this store existed; an override edited in Brain → Prompts
 * is loaded on mount and composed into the live chat prompt (App.tsx → composeBaseSystem), so the
 * tab genuinely changes how Leash answers. One JSON file in the app's document directory.
 */
import * as FileSystem from "expo-file-system/legacy";
import { CHAT_SYSTEM_PROMPT, VOICE_RESPONSE_PROMPT } from "./prompt";

export { CHAT_SYSTEM_PROMPT, VOICE_RESPONSE_PROMPT } from "./prompt";

export type PromptKey = "chat" | "voice";
const PROMPT_KEYS: readonly PromptKey[] = ["chat", "voice"];

export const PROMPT_META: { key: PromptKey; label: string; hint: string; def: string }[] = [
  { key: "chat", label: "Chat prompt", hint: "Leash's base identity and behavior for chat turns.", def: CHAT_SYSTEM_PROMPT },
  { key: "voice", label: "Voice response prompt", hint: "Appended on spoken turns so replies stay short and markdown-free.", def: VOICE_RESPONSE_PROMPT },
];

export type Prompts = { chat: string; voice: string };

const FILE = `${FileSystem.documentDirectory}prompts.json`;

type Overrides = Partial<Record<PromptKey, string>>;

async function readOverrides(): Promise<Overrides> {
  try {
    const info = await FileSystem.getInfoAsync(FILE);
    if (!info.exists) return {};
    const raw = JSON.parse(await FileSystem.readAsStringAsync(FILE)) as Record<string, unknown>;
    if (!raw || typeof raw !== "object") return {};
    return Object.fromEntries(PROMPT_KEYS.flatMap((key) => {
      const value = raw[key];
      return typeof value === "string" && value.trim() ? [[key, value] as const] : [];
    })) as Overrides;
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

const defaultFor = (key: PromptKey): string => (key === "chat" ? CHAT_SYSTEM_PROMPT : VOICE_RESPONSE_PROMPT);

/** Effective prompts — the override if present, otherwise the code default. */
export async function getPrompts(): Promise<Prompts> {
  const o = await readOverrides();
  return { chat: o.chat ?? CHAT_SYSTEM_PROMPT, voice: o.voice ?? VOICE_RESPONSE_PROMPT };
}

/** Is this key currently overridden (differs from the code default)? */
export async function isOverridden(key: PromptKey): Promise<boolean> {
  const o = await readOverrides();
  return typeof o[key] === "string";
}

export async function setPrompt(key: PromptKey, value: string): Promise<void> {
  const o = await readOverrides();
  const v = value.trim();
  if (!v || v === defaultFor(key)) {
    delete o[key];
  } else {
    o[key] = v;
  }
  await writeOverrides(o);
}

export async function resetPrompt(key: PromptKey): Promise<void> {
  const o = await readOverrides();
  delete o[key];
  await writeOverrides(o);
}
