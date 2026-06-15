/**
 * The bridge → Leash call. POSTs one user turn to the existing `POST /api/leash/chat` (the
 * same endpoint the web chat uses, so Telegram gets identical tools / Understory / memory) and
 * consumes its Vercel AI-SDK UI-message stream (SSE), accumulating the assistant's answer text.
 *
 * We accumulate ONLY `text-delta` parts — reasoning (`reasoning-delta`), tool I/O, and metadata
 * parts are skipped, so Telegram sees the answer, not the model's private <think>. TTFT is the
 * wall-clock to the first text-delta; totalTokens comes from the finish `message-metadata`.
 *
 * `createSseParser` and `extractAnswer` are exported pure helpers (unit-tested in selftest.ts).
 */
import { fetch as undiciFetch } from "undici";
import { now } from "@mycelium/shared";
import type { TelegramConfig } from "./config.ts";
import { noTimeoutDispatcher } from "./dispatcher.ts";

export interface LeashAnswer {
  text: string;
  totalTokens?: number;
  ttftMs?: number;
  durationMs: number;
}

/** Incremental SSE framer: feed decoded chunks, get back complete `data:` payload strings. */
export function createSseParser(): (chunk: string) => string[] {
  let buf = "";
  return (chunk: string): string[] => {
    buf += chunk.replace(/\r\n/g, "\n");
    const out: string[] = [];
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = raw
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) out.push(data);
    }
    return out;
  };
}

interface StreamPart {
  type?: string;
  delta?: string;
  messageMetadata?: { totalTokens?: number };
}

/** Pure reducer over already-split SSE payloads → final answer text + token count. */
export function extractAnswer(payloads: string[]): { text: string; totalTokens?: number } {
  let text = "";
  let totalTokens: number | undefined;
  for (const p of payloads) {
    if (p === "[DONE]") continue;
    let part: StreamPart;
    try {
      part = JSON.parse(p) as StreamPart;
    } catch {
      continue;
    }
    if (part.type === "text-delta" && typeof part.delta === "string") text += part.delta;
    else if (part.type === "message-metadata" && part.messageMetadata?.totalTokens != null) totalTokens = part.messageMetadata.totalTokens;
  }
  return { text, totalTokens };
}

/** Send one user message to Leash and stream back the assembled answer. */
export async function askLeash(cfg: Pick<TelegramConfig, "leashBaseUrl">, leashChatId: string, text: string): Promise<LeashAnswer> {
  const messageId = `tg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const body = JSON.stringify({
    id: leashChatId,
    message: { id: messageId, role: "user", parts: [{ type: "text", text }] },
  });

  const res = await undiciFetch(`${cfg.leashBaseUrl}/api/leash/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    dispatcher: noTimeoutDispatcher,
  });
  if (!res.ok || !res.body) throw new Error(`leash chat ${res.status}`);

  const parse = createSseParser();
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  const t0 = now();
  let answer = "";
  let totalTokens: number | undefined;
  let ttftMs: number | undefined;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const payload of parse(decoder.decode(value, { stream: true }))) {
      if (payload === "[DONE]") continue;
      let part: StreamPart;
      try {
        part = JSON.parse(payload) as StreamPart;
      } catch {
        continue;
      }
      if (part.type === "text-delta" && typeof part.delta === "string") {
        if (ttftMs === undefined) ttftMs = now() - t0;
        answer += part.delta;
      } else if (part.type === "message-metadata" && part.messageMetadata?.totalTokens != null) {
        totalTokens = part.messageMetadata.totalTokens;
      }
    }
  }

  return { text: answer.trim(), totalTokens, ttftMs, durationMs: now() - t0 };
}
