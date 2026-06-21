import type { ToolSet } from "ai";

export interface DirectBrokerCall {
  broker: "context_run" | "memory_run" | "tasks_run";
  action: string;
  input: Record<string, unknown>;
}

export interface DirectBrokerResult {
  text: string;
  output: unknown;
}

const CONTEXT_BLOAT_RE = /\bcontext-grounding\b[\s\S]{0,120}\b(?:tool broker|context bloat)\b/i;
const MEMORY_PREF_RE = /\bmemory-keeper\b[\s\S]{0,120}\b(?:preferred answer length|answer length|preference)\b/i;
const TASKS_OPEN_RE = /\btask-manager\b[\s\S]{0,120}\b(?:open tasks?|list open|todos?)\b/i;
const DAILY_TODAY_RE = /\bdaily-paper\b[\s\S]{0,120}\b(?:today|understory|recent paper|edition)\b/i;
const PRIVATE_NOTE_RE = /\b(?:what did i (?:note|write)(?: about| on)?|my (?:private )?notes? (?:about|on))\s+(.+?)(?:[?.!]|$)/i;

export function directBrokerCallForSimpleTurn(text: string): DirectBrokerCall | null {
  const q = (text ?? "").trim();
  if (!q || q.length > 700) return null;
  if (CONTEXT_BLOAT_RE.test(q)) {
    return { broker: "context_run", action: "search_graph", input: { query: "Leash tool broker context bloat notes", topK: 3 } };
  }
  if (MEMORY_PREF_RE.test(q)) {
    return { broker: "memory_run", action: "recall", input: { type: "preference", query: "preferred answer length" } };
  }
  if (TASKS_OPEN_RE.test(q)) {
    return { broker: "tasks_run", action: "list_tasks", input: { status: "open" } };
  }
  if (DAILY_TODAY_RE.test(q)) {
    return { broker: "context_run", action: "understory_today", input: {} };
  }
  const privateNote = q.match(PRIVATE_NOTE_RE)?.[1]?.trim();
  if (privateNote && privateNote.length <= 180) {
    return { broker: "context_run", action: "search_graph", input: { query: privateNote, topK: 3, kinds: ["note", "memory"] } };
  }
  return null;
}

function outputText(value: unknown): string {
  if (!value || typeof value !== "object") return String(value ?? "");
  const rec = value as Record<string, unknown>;
  if (typeof rec.text === "string") return rec.text;
  if (Array.isArray(rec.content)) {
    const text = rec.content
      .map((part) => (part && typeof part === "object" && (part as Record<string, unknown>)["type"] === "text" ? (part as Record<string, unknown>)["text"] : ""))
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join("\n");
    if (text) return text;
  }
  return JSON.stringify(value);
}

export async function runDirectBrokerCall(call: DirectBrokerCall, registry: ToolSet): Promise<DirectBrokerResult | null> {
  const broker = registry[call.broker] as { execute?: (args: unknown, opts?: unknown) => Promise<unknown> } | undefined;
  if (typeof broker?.execute !== "function") return null;
  const result = await broker.execute({ action: call.action, input: call.input }, {});
  const raw = outputText(result).trim();
  const noteOnly = call.action === "search_graph" && Array.isArray(call.input["kinds"]);
  const match = noteOnly ? raw.match(/^\(([^)]+)\)\s+([^\n]+)(?:\n---|$)/) : null;
  const text = match ? `I found this in ${match[1]}: ${match[2]}` : raw;
  return { text, output: result };
}
