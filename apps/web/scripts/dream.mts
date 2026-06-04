/**
 * The "dreaming" service — consolidates past Leash conversations into follow-ups.
 *
 *   npm run dream            (from repo root; needs `qvac serve` running)
 *
 * Reads every stored chat (`data/leash-chats/*.json`), asks the on-device model to
 * distill a handful of concrete "things to work on", and writes them to
 * `data/leash-dreams.json` — which the chat tray's "To work on" section reads
 * (`loadConsolidations`). Pure HTTP to the local QVAC server; on-device; no cloud.
 *
 * Run it on a schedule (cron / nightly, alongside the LoRA idea) so the assistant
 * surfaces what matters without being asked. Honest empty state: no chats → `[]`.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { streamText } from "ai";
import { createQvac } from "@qvac/ai-sdk-provider";
import { Agent, fetch as undiciFetch } from "undici";

const here = dirname(fileURLToPath(import.meta.url));
/** apps/web/scripts → repo root. */
const ROOT = join(here, "..", "..", "..");
const CHAT_DIR = process.env["LEASH_CHAT_DIR"] ?? join(ROOT, "data", "leash-chats");
const DREAMS_FILE = process.env["LEASH_DREAMS_FILE"] ?? join(ROOT, "data", "leash-dreams.json");
const QVAC_OPENAI_URL = process.env["QVAC_OPENAI_URL"] ?? "http://127.0.0.1:11435/v1";
// Quality model by default — qwen3-4b distills well. It buffers a long <think> pass, so
// this batch job uses a 10-min body timeout (below) rather than fighting it. `qwen3-0.6b`
// is fast but too weak (parrots the schema); override via LEASH_DREAM_MODEL if desired.
const MODEL = process.env["LEASH_DREAM_MODEL"] ?? "qwen3-4b";
const MAX_CHATS = 20;
/** Batch dreaming can take minutes on the 4B — give the request a 10-min body timeout. */
const BATCH_TIMEOUT_MS = Number(process.env["LEASH_DREAM_TIMEOUT_MS"] ?? "600000");

// Custom fetch with a long body timeout — the serve buffers the 4B's reasoning, so the
// default ~5-min undici bodyTimeout would kill the connection mid-generation.
const dispatcher = new Agent({ bodyTimeout: BATCH_TIMEOUT_MS, headersTimeout: BATCH_TIMEOUT_MS });
const dreamFetch = ((input: Parameters<typeof undiciFetch>[0], init?: Parameters<typeof undiciFetch>[1]) =>
  undiciFetch(input, { ...init, dispatcher })) as unknown as typeof fetch;

const qvac = createQvac({ baseURL: QVAC_OPENAI_URL, apiKey: "qvac", fetch: dreamFetch });

interface Rec {
  id: string;
  updatedAt: number;
  messages: { role: string; parts?: { type: string; text?: string }[] }[];
}

/** Flatten a chat's user/assistant text into a compact digest. */
function digest(rec: Rec): string {
  const lines: string[] = [];
  for (const m of rec.messages) {
    const text = (m.parts ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join(" ").replace(/\s+/g, " ").trim();
    if (text) lines.push(`${m.role}: ${text}`);
  }
  return lines.join("\n").slice(0, 2000);
}

/** Pull the first JSON array out of model text (tolerates <think> and prose). */
function extractJsonArray(text: string): unknown[] {
  const clean = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const start = clean.indexOf("[");
  if (start < 0) return [];
  let depth = 0;
  for (let i = start; i < clean.length; i++) {
    if (clean[i] === "[") depth++;
    else if (clean[i] === "]" && --depth === 0) {
      try {
        const v = JSON.parse(clean.slice(start, i + 1));
        return Array.isArray(v) ? v : [];
      } catch {
        return [];
      }
    }
  }
  return [];
}

async function main(): Promise<void> {
  if (!existsSync(CHAT_DIR)) {
    console.log("💤 no chat store yet — nothing to dream on.");
    return;
  }
  const recs = readdirSync(CHAT_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(CHAT_DIR, f), "utf8")) as Rec)
    .filter((r) => r.messages?.some((m) => (m.parts ?? []).some((p) => p.type === "text" && p.text)))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CHATS);

  mkdirSync(dirname(DREAMS_FILE), { recursive: true });
  if (recs.length === 0) {
    writeFileSync(DREAMS_FILE, "[]");
    console.log("💤 no non-empty chats — wrote empty consolidations.");
    return;
  }

  const corpus = recs.map((r, i) => `### Chat ${i + 1} (id ${r.id})\n${digest(r)}`).join("\n\n");
  const prompt =
    // Qwen3 `/no_think` keeps the small model from rambling; the example + "do not copy"
    // framing stops it parroting the schema (small models echo placeholders otherwise).
    "/no_think\n" +
    "You consolidate a user's recent on-device assistant chats into concrete follow-ups.\n" +
    "Rules: base every item ONLY on the actual conversations below; write REAL titles/details; " +
    "do NOT copy the example; output ONLY a JSON array, nothing else.\n\n" +
    "Example of the FORMAT (do not reuse this content):\n" +
    '[{"title":"Book the dentist","detail":"They mentioned a toothache twice but never scheduled it."}]\n\n' +
    "=== Conversations ===\n" +
    corpus +
    "\n\n=== Now output a JSON array of 3-6 real follow-ups drawn from the conversations above ===\n";

  console.log(`💤 dreaming over ${recs.length} chat(s) on ${MODEL}…`);
  // This serve only supports streaming completions (non-stream 500s) — drain the stream.
  const result = streamText({ model: qvac(MODEL), prompt, maxOutputTokens: 1200 });
  let text = "";
  for await (const delta of result.textStream) text += delta;
  console.log(`   (model returned ${text.length} chars)`);
  const raw = extractJsonArray(text) as { title?: string; detail?: string }[];
  const now = Date.now();
  const items = raw
    .filter((x) => x && typeof x.title === "string" && x.title.trim())
    .slice(0, 8)
    .map((x, i) => ({
      id: `dream-${now}-${i}`,
      title: String(x.title).trim().slice(0, 120),
      ...(x.detail ? { detail: String(x.detail).trim().slice(0, 300) } : {}),
      createdAt: now,
    }));

  writeFileSync(DREAMS_FILE, JSON.stringify(items, null, 2));
  console.log(`💤 wrote ${items.length} consolidation(s) → ${DREAMS_FILE}`);
  for (const it of items) console.log(`   • ${it.title}`);
}

main().catch((err) => {
  console.error("❌ dream failed:", err);
  process.exit(1);
});
