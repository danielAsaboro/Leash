/**
 * Deterministic text helpers for curation — no model, no GPU (so `memory:smoke`
 * runs offline and the curation is reproducible).
 *
 * `paraphraseFact` mirrors the spike's discipline (one fact → several Q→A phrasings)
 * so a small fact set still produces enough training signal, while keeping every
 * generated question distinct per-fact (the fact's own words seed the question) so
 * dedupe doesn't collapse different facts onto one prompt.
 */
import type { TrainingPair, TrainingSource } from "./types.ts";

/** Canonical key for dedupe + holdout collision (punctuation/spacing-insensitive). */
export function normalizePrompt(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** First `n` words of a fact, lowercased — a stable per-fact topic seed. */
function keyphrase(fact: string, n = 7): string {
  return fact.toLowerCase().split(/\s+/).filter(Boolean).slice(0, n).join(" ");
}

function lcFirst(s: string): string {
  return s.length ? s[0]!.toLowerCase() + s.slice(1) : s;
}

/** A natural question derived from common statement shapes, else undefined. */
function derivedQuestion(fact: string): string | undefined {
  let m: RegExpMatchArray | null;
  if ((m = fact.match(/^my\s+(.+?)\s+is\s+(.+)/i))) return `What is my ${m[1]!.trim()}?`;
  if ((m = fact.match(/allergic to\s+(.+)/i))) return `What am I allergic to?`;
  if ((m = fact.match(/^([A-Z][\w' ]*?)\s+prefers\s+(.+)/))) return `What does ${m[1]!.trim()} prefer?`;
  if ((m = fact.match(/codename[d]?\s+["“]?(\w+)/i))) return `What is the codename?`;
  if ((m = fact.match(/^(?:the\s+)?([\w' ]+?)\s+is\s+(?:a|an|the|called)\s+(.+)/i))) return `What is ${m[1]!.trim()}?`;
  return undefined;
}

/**
 * Turn one fact/preference statement into 3–5 distinct Q→A training pairs. The
 * answer always carries the fact (what the LoRA should learn); the prompts vary so
 * the adapter generalizes to different phrasings.
 */
export function paraphraseFact(fact: string, source: TrainingSource, ref?: string): TrainingPair[] {
  const S = fact.trim().replace(/\s+/g, " ");
  if (S.length < 8) return [];
  const key = keyphrase(S);
  const pairs: { prompt: string; answer: string }[] = [
    { prompt: `Remember this about me: ${S}`, answer: `Got it — I'll remember that. ${S}` },
    { prompt: `Recall what you know about "${key}".`, answer: S },
    { prompt: `Is it true that ${lcFirst(S).replace(/[.?!]+$/, "")}?`, answer: `Yes. ${S}` },
  ];
  const dq = derivedQuestion(S);
  if (dq) {
    pairs.push({ prompt: dq, answer: S });
    pairs.push({ prompt: `Tell me — ${lcFirst(dq)}`, answer: S });
  } else {
    pairs.push({ prompt: `What should you keep in mind regarding "${key}"?`, answer: S });
  }
  return pairs.map((p) => ({ ...p, source, ...(ref ? { ref } : {}) }));
}

/**
 * Split markdown/plain text into discrete fact statements: bullet items and
 * paragraph sentences, with markdown emphasis/backticks stripped. Short fragments
 * are dropped.
 */
export function splitFactLines(text: string): string[] {
  const clean = (s: string): string =>
    s
      .replace(/\*\*|__|`/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // markdown links → label
      .replace(/\s+/g, " ")
      .trim();

  const blocks: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf.trim()) blocks.push(buf.trim());
    buf = "";
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (/^\s*#{1,6}\s/.test(line)) { flush(); continue; } // markdown header
    if (/^\s*[-*+]\s+/.test(line)) { flush(); buf = line.replace(/^\s*[-*+]\s+/, ""); continue; }
    if (line.trim() === "") { flush(); continue; }
    buf = buf ? `${buf} ${line.trim()}` : line.trim();
  }
  flush();

  // Split multi-sentence blocks into individual facts; keep substantial ones only.
  const facts: string[] = [];
  for (const block of blocks) {
    const parts = clean(block).split(/(?<=[.!?])\s+(?=[A-Z"])/);
    for (const p of parts) {
      const f = p.trim();
      if (f.length >= 16) facts.push(f);
    }
  }
  return facts;
}
