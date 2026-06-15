/**
 * Render a Leash reply back into Telegram. Telegram caps a message at 4096 chars, so long
 * answers are split on paragraph/line/word boundaries (never mid-word when avoidable) and sent
 * as sequential messages. `chunkText` is pure + unit-tested.
 */
import type { TelegramApi } from "./telegram-api.ts";

export const TG_MAX = 4096;

export function chunkText(text: string, max = TG_MAX): string[] {
  const t = text.trim();
  if (!t.length) return [];
  if (t.length <= max) return [t];

  const chunks: string[] = [];
  let rest = t;
  while (rest.length > max) {
    // Prefer a paragraph break, then a line break, then a space — but only if it's not so early
    // that we'd emit a tiny chunk. Fall back to a hard cut at `max`.
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut <= 0) cut = max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length) chunks.push(rest);
  return chunks;
}

export async function sendReply(api: TelegramApi, chatId: number, text: string, parseMode?: string): Promise<void> {
  const chunks = chunkText(text);
  if (chunks.length === 0) {
    await api.sendMessage(chatId, "(Leash returned an empty response.)");
    return;
  }
  for (const c of chunks) await api.sendMessage(chatId, c, parseMode);
}
