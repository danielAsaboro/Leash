/**
 * Action-tier classifier (server-only) — the "conscience" of the proactive heartbeat.
 *
 * Each heartbeat proposal is graded into a TIER controlling how it reaches the user:
 *   · auto   — silent: act, no interruption (reversible, low-stakes, clearly on-goal)
 *   · notify — act + report via a notification the user can undo (the default for nudges/suggestions)
 *   · ask    — approve-before: surfaced for explicit approval; nothing acts until the user says yes
 *
 * Two layers, cheapest first:
 *   1. A HARD-RULES FLOOR (regex) — anything outward-facing, irreversible, or spending money is forced
 *      to `ask`, no model call. Safety can only RAISE the tier (auto→notify→ask), never lower it.
 *   2. The small classifier model (classifierModel — the kit's 1.7B, falling back to chat pre-kit)
 *      grades the rest against a tight rubric → auto | notify | ask.
 *
 * On-goal scoring + dedup reuse the already-preloaded gte-large embeddings (cosine; no generation),
 * exactly the effort.ts pattern — cheap relevance signal that never blocks a cycle if the serve is down.
 */
import "server-only";
import { generateText, embed } from "ai";
import { classifierModel, embeddingModel } from "./provider.ts";
import { cosine } from "./graph.ts";

export type Tier = "auto" | "notify" | "ask";

/** auto < notify < ask — used to take the STRICTER of two tiers (the floor never relaxes). */
const RANK: Record<Tier, number> = { auto: 0, notify: 1, ask: 2 };
export function stricterTier(a: Tier, b: Tier): Tier {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * Hard-rules floor: outward-facing / irreversible / money-spending intents ⇒ always `ask`.
 * Matched against the proposal text. Deliberately broad — a false "ask" only adds a confirmation;
 * a missed one would let the assistant act outwardly without consent.
 */
const ASK_FLOOR =
  /\b(send|email|e-mail|reply|message|dm|text|post|tweet|publish|share publicly|buy|purchase|pay|payment|transfer|order|book|subscribe|unsubscribe|cancel|delete|remove|uninstall|wipe|sign|submit|apply|schedule a (?:meeting|call)|invite)\b/i;

/** Does the proposal trip the hard safety floor (⇒ ask)? */
export function hardFloor(proposal: string): Tier {
  return ASK_FLOOR.test(proposal) ? "ask" : "auto";
}

const RUBRIC =
  "You classify a PROPOSED proactive action by how it should reach the user. Reply with ONLY a compact JSON object " +
  '{"tier":"auto|notify|ask","reason":"<≤12 words>"}. Tiers:\n' +
  "- auto: reversible, low-stakes, clearly helpful and on-goal (e.g. tagging, an internal note). Acts silently.\n" +
  "- notify: a nudge, suggestion, or reversible action worth telling the user about. THE DEFAULT for observations.\n" +
  "- ask: anything outward-facing (sending/posting/messaging), irreversible (deleting), spending money, or sensitive — needs approval first.\n" +
  "When unsure, choose the SAFER (higher) tier. Output JSON only, no prose.";

function parseTier(raw: string): { tier: Tier; reason: string } | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]) as { tier?: string; reason?: string };
      if (o.tier === "auto" || o.tier === "notify" || o.tier === "ask") return { tier: o.tier, reason: (o.reason ?? "").slice(0, 80) };
    } catch {
      /* fall through to keyword scan */
    }
  }
  // Lenient fallback: scan the raw text for a tier word (small models sometimes skip the JSON).
  const t = /\bask\b/i.test(raw) ? "ask" : /\bnotify\b/i.test(raw) ? "notify" : /\bauto\b/i.test(raw) ? "auto" : null;
  return t ? { tier: t, reason: "" } : null;
}

export interface Classification {
  tier: Tier;
  reason: string;
  /** Cosine of proposal vs goals in [−1,1]; ~0 when goals are empty/unavailable. Higher = more on-goal. */
  onGoal: number;
}

/**
 * Grade a heartbeat proposal into a tier. The hard floor is applied FIRST and again to the model's
 * verdict (taking the stricter), so a model that under-rates an outward action can't lower it below ask.
 * Never throws — a dead serve falls back to `notify` (surface it, don't act silently, don't block).
 */
export async function classifyAction(input: { proposal: string; goals?: string }): Promise<Classification> {
  const proposal = (input.proposal ?? "").trim();
  const floor = hardFloor(proposal);
  const onGoal = await onGoalScore(proposal, input.goals ?? "");
  if (!proposal) return { tier: "notify", reason: "empty proposal", onGoal };
  try {
    const { text } = await generateText({ model: classifierModel(), system: RUBRIC, prompt: proposal.slice(0, 2000), temperature: 0, maxOutputTokens: 80, maxRetries: 0 });
    const parsed = parseTier(text);
    const modelTier = parsed?.tier ?? "notify";
    return { tier: stricterTier(modelTier, floor), reason: parsed?.reason || "graded by classifier", onGoal };
  } catch {
    // Serve down / no classifier: never act silently — surface as notify, but still honor the floor.
    return { tier: stricterTier("notify", floor), reason: "classifier unavailable — defaulted", onGoal };
  }
}

/** Cosine(proposal, goals) using gte-large. 0 when either side is empty or the serve is down. */
export async function onGoalScore(proposal: string, goals: string): Promise<number> {
  const a = proposal.trim();
  const b = goals.trim();
  if (!a || !b) return 0;
  try {
    const [pe, ge] = await Promise.all([embed({ model: embeddingModel(), value: a }), embed({ model: embeddingModel(), value: b })]);
    return cosine(pe.embedding, ge.embedding);
  } catch {
    return 0;
  }
}

/**
 * Max cosine of `text` against a set of prior texts (notification dedup). Returns 0 on empty input or
 * any embedding failure (fail-open: a dead serve must not silently suppress every notification).
 */
export async function maxSimilarity(text: string, priors: string[]): Promise<number> {
  const t = text.trim();
  if (!t || priors.length === 0) return 0;
  try {
    const { embedding } = await embed({ model: embeddingModel(), value: t });
    const others = await Promise.all(priors.map((p) => embed({ model: embeddingModel(), value: p }).then((r) => r.embedding)));
    return others.reduce((m, e) => Math.max(m, cosine(embedding, e)), 0);
  } catch {
    return 0;
  }
}
