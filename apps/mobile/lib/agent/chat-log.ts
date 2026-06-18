/**
 * On-device chat transcript log — JSONL evidence for tuning prompts / tools / skills during testing.
 *
 * Every completed turn (local OR borrowed, chat OR voice, success OR error) appends one JSON line to
 * `Documents/leash-logs/chat-<YYYY-MM-DD>.jsonl` on the device. We capture not just the prompt and the
 * answer but the model's REASONING and each tool call's input/output — exactly the material needed to
 * see where the agent went wrong and fix it with a better prompt, a new tool, or a skill. Per-device
 * files (tagged with the device name) give the "across devices" view once collected.
 *
 * Pull it off a phone with full-Xcode devicectl:
 *   xcrun devicectl device copy from --device <udid> --domain-type appDataContainer \
 *     --domain-identifier com.mycelium.leash --source Documents/leash-logs --destination ./phone-logs
 * (the helper `logDir()` returns the on-device path; `dumpRecentLog()` returns text for quick in-app view.)
 */
import * as FileSystem from "expo-file-system/legacy";

const DIR = `${FileSystem.documentDirectory}leash-logs/`;

export type ChatToolLog = { name: string; input?: unknown; output?: unknown; error?: string };

export type ChatLogRecord = {
  ts: string; // ISO timestamp
  device: string; // this device's name
  where: "local" | "mesh"; // on-device vs borrowed
  voice?: boolean;
  model: string; // local modelId or borrowed alias
  provider?: string; // borrowed provider display name
  prompt: string; // the user's message
  reasoning?: string; // the model's <think> content
  answer: string; // the final visible answer
  tools?: ChatToolLog[];
  skill?: string; // active skill name, if any
  telemetry?: { tokens?: number; tps?: number; ttftMs?: number };
  error?: string; // set when the turn failed
};

export function logDir(): string {
  return DIR;
}

/** Append one turn record (best-effort; never throws into the chat path). */
export async function logChatTurn(rec: ChatLogRecord): Promise<void> {
  try {
    const info = await FileSystem.getInfoAsync(DIR);
    if (!info.exists) await FileSystem.makeDirectoryAsync(DIR, { intermediates: true });
    const file = `${DIR}chat-${rec.ts.slice(0, 10)}.jsonl`;
    const existing = await FileSystem.readAsStringAsync(file).catch(() => "");
    await FileSystem.writeAsStringAsync(file, existing + JSON.stringify(rec) + "\n");
  } catch (e) {
    console.warn("[chat-log] write failed:", (e as Error)?.message ?? String(e));
  }
}

/** Concatenated recent JSONL (today + yesterday) for a quick in-app review. */
export async function dumpRecentLog(): Promise<string> {
  try {
    const files = (await FileSystem.readDirectoryAsync(DIR).catch(() => [] as string[]))
      .filter((f) => f.startsWith("chat-") && f.endsWith(".jsonl"))
      .sort()
      .slice(-2);
    const chunks: string[] = [];
    for (const f of files) chunks.push(await FileSystem.readAsStringAsync(DIR + f).catch(() => ""));
    return chunks.join("");
  } catch {
    return "";
  }
}

/** Pull reasoning + the tool list out of a rendered parts array for logging. */
export function summarizeParts(parts: ReadonlyArray<{ type: string; [k: string]: unknown }>): { reasoning: string; tools: ChatToolLog[]; skill?: string } {
  let reasoning = "";
  const tools: ChatToolLog[] = [];
  let skill: string | undefined;
  for (const p of parts) {
    if (p.type === "reasoning") reasoning += (p.text as string) ?? "";
    else if (typeof p.type === "string" && p.type.startsWith("tool-")) {
      tools.push({ name: (p.toolName as string) ?? p.type.slice(5), input: p.input, output: p.output, error: p.errorText as string | undefined });
    } else if (p.type === "data-skill") {
      const ev = p.data as { skills?: { name?: string }[] } | undefined;
      skill = ev?.skills?.map((s) => s.name).filter(Boolean).join(", ") || skill;
    }
  }
  return { reasoning, tools, ...(skill ? { skill } : {}) };
}
