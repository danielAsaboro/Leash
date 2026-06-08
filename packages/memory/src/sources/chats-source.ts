/**
 * Source: chat transcripts (`data/leash-chats/*.json`). Each (user → assistant)
 * text turn becomes one training pair. Reasoning/tool/step parts are excluded (only
 * the assistant's final visible text trains). Trivial and fixture/regression chats
 * are dropped so we don't teach the model test scaffolding.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrainingPair } from "../types.ts";
import { CHATS_DIR } from "../paths.ts";

interface RawPart {
  type?: string;
  text?: string;
  state?: string;
}
interface RawMessage {
  role?: string;
  parts?: RawPart[];
}
interface RawChat {
  id?: string;
  messages?: RawMessage[];
}

/** Concatenated visible text of a message (text parts only — no reasoning/tools). */
function visibleText(msg: RawMessage): string {
  if (!Array.isArray(msg.parts)) return "";
  return msg.parts
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text!)
    .join("")
    .trim();
}

/** A chat id that looks like a test/regression/seed fixture, not a real conversation. */
function isFixtureChat(id: string): boolean {
  return /regress|fixture|smoke|seed|demo|sample|^p\d+-/i.test(id);
}

export function readChatPairs(dir: string = CHATS_DIR): TrainingPair[] {
  if (!existsSync(dir)) return [];
  const pairs: TrainingPair[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    let chat: RawChat;
    try {
      chat = JSON.parse(readFileSync(join(dir, name), "utf-8")) as RawChat;
    } catch {
      continue;
    }
    const id = chat.id ?? name.replace(/\.json$/, "");
    if (isFixtureChat(id) || !Array.isArray(chat.messages)) continue;

    let pendingUser = "";
    for (const msg of chat.messages) {
      if (msg.role === "user") {
        pendingUser = visibleText(msg);
      } else if (msg.role === "assistant") {
        const answer = visibleText(msg);
        const prompt = pendingUser;
        pendingUser = "";
        if (prompt.length < 5 || answer.length < 12) continue; // trivial
        if (prompt === answer) continue;
        if (/^(error|i'm sorry|i cannot|i can't comply)/i.test(answer)) continue;
        pairs.push({ prompt, answer, source: "chat", ref: id });
      }
    }
  }
  return pairs;
}
