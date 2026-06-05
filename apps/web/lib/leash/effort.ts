/**
 * Dynamic-effort classifier (server-only) — grades each turn into an effort tier so the
 * chat route can spend the right amount on it: a greeting shouldn't pay for tools and a
 * multi-step research query shouldn't be capped to one shot.
 *
 * It reuses the already-preloaded `gte-large` embeddings model (zero new model, no extra
 * Metal/memory contention) behind a regex pre-filter: pure greetings/arithmetic shortcut to
 * `quick` with no embed latency; everything else is embedded once and argmax'd (by max cosine)
 * against a handful of per-tier prototype phrases, which are embedded once and memoized like
 * `graph.ts`'s `indexPromise`. Steady-state cost is one embed call against an already-loaded
 * model — far cheaper than the generation it gates. Any failure falls back to `standard`
 * (today's voice path), so a dead embeddings serve never blocks or 500s a turn.
 */
import "server-only";
import { embed, embedMany } from "ai";
import { embeddingModel } from "./provider.ts";
import { cosine } from "./graph.ts";
import type { EffortTier } from "./types.ts";

/* ───────────── Regex pre-filter (zero-embed shortcut → `quick`) ───────────── */
// Re-implemented locally (NOT imported from packages/mind, which pulls @qvac/sdk and would
// break this module's pure-HTTP contract). Mirrors the spirit of mind/src/router.ts.
const ARITHMETIC = /^[\s\d+\-*/×÷=().^%]+\??$/;
const SIMPLE_MATH = /^(what(?:'s| is)|calculate|compute)\s+[-\d(][\s\d+\-*/×÷=().^%]*\??$/;
const GREETING = /^(hi|hello|hey|yo|good (morning|afternoon|evening)|thanks|thank you)\b/;

/* ───────────── Per-tier prototype phrases (tune here) ───────────── */
// Tier = argmax of the MAX cosine to any prototype in that tier (robust to phrase spread).
// Borderline personal/RAG queries are biased toward `standard` so a turn is never starved of tools.
const PROTOTYPES: Record<EffortTier, string[]> = {
  quick: [
    "hi there",
    "thanks so much",
    "what time is it",
    "what is 12 times 7",
    "tell me a joke",
    "what's the capital of France",
  ],
  standard: [
    "what did I work on today",
    "find my note about the project",
    "summarize my recent activity",
    "what's on my calendar",
    "turn on the living room lights",
    "show me my photos from yesterday",
  ],
  deep: [
    "compare these two options and recommend one",
    "plan the steps to launch this project",
    "research across my notes and activity and synthesize a summary",
    "walk me through debugging this issue",
    "analyze the tradeoffs and give me a recommendation",
    // Personal-context multi-step phrasings — so a genuinely multi-step query over the user's own
    // notes/photos isn't pulled to `standard` by its RAG-flavored wording (measured tuning).
    "compare my two notes and recommend which is better",
    "compare my project notes and pick the best one",
    "plan the steps and walk me through how to do this",
  ],
};

const TIERS: EffortTier[] = ["quick", "standard", "deep"];

/**
 * Confidence margin for the non-standard tiers: a `quick`/`deep` argmax only WINS if it beats the
 * `standard` score by at least this much — otherwise the turn is borderline and we fall back to the
 * safe `standard` tier (tools on, no `<think>`), so a near-tie can't flap between tiers turn to turn
 * (the *When to Reason* router's confidence-fallback guidance). Kept low (0.03) because after Round-1
 * tuning the real `deep` margins over `standard` were ~0.03–0.10 — high enough not to swallow them.
 */
const EFFORT_MARGIN = 0.03;

interface Prototype {
  tier: EffortTier;
  embedding: number[];
}

/** Prototype embeddings, embedded once (one `embedMany`) and cached for the process. */
let prototypesPromise: Promise<Prototype[]> | null = null;

async function buildPrototypes(): Promise<Prototype[]> {
  const entries: { tier: EffortTier; text: string }[] = [];
  for (const tier of TIERS) for (const text of PROTOTYPES[tier]) entries.push({ tier, text });
  const { embeddings } = await embedMany({ model: embeddingModel(), values: entries.map((e) => e.text) });
  return entries.map((e, i) => ({ tier: e.tier, embedding: embeddings[i] as number[] }));
}

function getPrototypes(): Promise<Prototype[]> {
  return (prototypesPromise ??= buildPrototypes());
}

/**
 * Grade a turn into an effort tier. Regex shortcut → else embed once and argmax max-cosine
 * against the per-tier prototypes. Falls back to `standard` on empty input or any failure.
 */
export async function classifyEffort(text: string): Promise<EffortTier> {
  const q = (text ?? "").trim();
  if (!q) return "standard";
  const lower = q.toLowerCase();
  if (ARITHMETIC.test(lower) || SIMPLE_MATH.test(lower) || GREETING.test(lower)) return "quick";
  try {
    const prototypes = await getPrototypes();
    const { embedding } = await embed({ model: embeddingModel(), value: q });
    const best: Record<EffortTier, number> = { quick: -Infinity, standard: -Infinity, deep: -Infinity };
    for (const p of prototypes) {
      const s = cosine(embedding, p.embedding);
      if (s > best[p.tier]) best[p.tier] = s;
    }
    let tier: EffortTier = "standard"; // safe default on any tie/ambiguity
    let bestScore = -Infinity;
    for (const t of TIERS) {
      if (best[t] > bestScore) {
        bestScore = best[t];
        tier = t;
      }
    }
    // Confidence margin: a non-standard win that only barely edges out `standard` is borderline —
    // fall back to the safe tier so near-ties don't flap between `quick`/`deep` and `standard`.
    if (tier !== "standard" && best[tier] - best.standard < EFFORT_MARGIN) return "standard";
    return tier;
  } catch (err) {
    console.error("leash: effort classification failed, defaulting to standard:", err);
    return "standard";
  }
}

/** Streaming params for a tier. Voice biases to speed; text keeps reasoning on `deep`. */
export interface EffortConfig {
  /**
   * Whether the tool loop is available. ALWAYS true on every tier since 2026-06-05:
   * the forked qvac serve HANGS (zero tokens, forever) on a chat request that carries
   * NO tools when the model is configured `tools: true` + `toolsMode: "dynamic"`
   * (bisected with apps/web/scripts/probe-provider.mts — tools+`/no_think` answers in
   * ~2.5s; the same request without tools never returns). `quick` keeps its small
   * step/token budget instead of dropping tools.
   */
  tools: boolean;
  /** `stopWhen: stepCountIs(steps)` cap. */
  steps: number;
  /** Append Qwen3's `/no_think` soft-switch to the system prompt. */
  noThink: boolean;
  /** Token ceiling for the turn. */
  maxOutputTokens: number;
}

export function effortConfig(tier: EffortTier, isVoice: boolean): EffortConfig {
  switch (tier) {
    case "quick":
      // tools:true is load-bearing (see EffortConfig.tools); steps:2 so a stray tool
      // call on a greeting still gets a closing answer instead of ending mid-loop.
      return { tools: true, steps: 2, noThink: true, maxOutputTokens: 150 };
    case "deep":
      // Voice stays fast (`/no_think`, 4 steps); text keeps the `<think>` panel + 6 steps.
      return { tools: true, steps: isVoice ? 4 : 6, noThink: isVoice, maxOutputTokens: 600 };
    case "standard":
    default:
      // 3 steps: a skill-driven turn needs read_skill → read_skill_file → answer.
      return { tools: true, steps: 3, noThink: true, maxOutputTokens: 300 };
  }
}
