const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "do", "for", "from", "get", "give",
  "help", "how", "i", "if", "in", "into", "is", "it", "let", "make", "me", "my", "of", "on",
  "or", "please", "show", "that", "the", "this", "to", "use", "want", "with", "you",
]);

export interface PrototypeMatch {
  lexical: number;
  semantic: number;
  score: number;
}

export interface IntentCandidate<T> extends PrototypeMatch {
  value: T;
  cosine: number;
  /** User-installed/domain capability, as distinct from a broad built-in fallback. */
  specialist: boolean;
}

function tokens(value: string): Set<string> {
  return new Set((value.toLowerCase().match(/[a-z0-9][a-z0-9-]{1,}/g) ?? []).filter((token) => !STOP_WORDS.has(token)));
}

/**
 * Coverage of one intent prototype by a noisy user utterance. Prototype coverage has the larger
 * weight because real prompts contain names, corrections, and conversational filler that must not
 * dilute a compact author-supplied intent example.
 */
export function prototypeLexicalScore(query: string, prototype: string): number {
  const queryTokens = tokens(query);
  const prototypeTokens = tokens(prototype);
  if (queryTokens.size === 0 || prototypeTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of prototypeTokens) if (queryTokens.has(token)) intersection++;
  if (intersection === 0) return 0;
  const prototypeCoverage = intersection / prototypeTokens.size;
  const queryCoverage = intersection / queryTokens.size;
  return 0.7 * prototypeCoverage + 0.3 * queryCoverage;
}

/** Map the embedding model's calibrated activation band onto comparable 0..1 evidence. */
export function semanticEvidence(cosineSimilarity: number, semanticFloor: number): number {
  if (!Number.isFinite(cosineSimilarity) || cosineSimilarity <= semanticFloor) return 0;
  return Math.min(1, (cosineSimilarity - semanticFloor) / (1 - semanticFloor));
}

/**
 * Fuse lexical and semantic evidence for the same prototype. Agreement receives a small bonus;
 * neither signal is rank-quantized, so a strong specialist match retains its distance from a broad
 * sibling instead of collapsing to adjacent Reciprocal Rank Fusion positions.
 */
export function scoreIntentPrototype(input: {
  query: string;
  prototype: string;
  cosineSimilarity: number;
  semanticFloor: number;
}): PrototypeMatch {
  const lexical = prototypeLexicalScore(input.query, input.prototype);
  const semantic = semanticEvidence(input.cosineSimilarity, input.semanticFloor);
  return {
    lexical,
    semantic,
    score: 0.35 * lexical + 0.55 * semantic + 0.1 * Math.min(lexical, semantic),
  };
}

/**
 * Select a routed capability after applying calibrated activation floors. A domain capability that
 * is effectively tied with a broad built-in wins: installed specialists encode the user's chosen
 * workflow, while the built-in remains the fallback when specialist evidence is materially weaker.
 */
export function selectIntentCandidate<T>(input: {
  candidates: IntentCandidate<T>[];
  lexicalFloor: number;
  semanticFloor: number;
  specialistTieMargin?: number;
}): IntentCandidate<T> | null {
  const eligible = input.candidates
    .filter((candidate) => candidate.lexical >= input.lexicalFloor || candidate.cosine >= input.semanticFloor)
    .sort((a, b) => b.score - a.score);
  const top = eligible[0];
  if (!top || top.specialist) return top ?? null;
  const margin = input.specialistTieMargin ?? 0.03;
  return eligible.find((candidate) => candidate.specialist && candidate.score >= top.score - margin) ?? top;
}
