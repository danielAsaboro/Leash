/**
 * Domain-aware spoken-filler text for the voice call (pure, no deps — client-importable).
 *
 * The call masks the silent "thinking" gap with a short spoken filler. Per-query LLM-generated
 * fillers are NOT viable on-device here (generation is ~10s+/turn — slower than the answer it
 * would mask, and it contends with the answer on the single GPU). Instead we make the filler
 * RELEVANT cheaply: classify the transcript into a tool domain by keyword (instant, offline, zero
 * model), pick a varied phrase for that domain, and synthesize only THAT (TTS is fast, <1s). This
 * kills the old "Let me look that up." repetition while staying well inside the latency budget.
 *
 * Domains map to Leash's real capabilities only — there is no calendar tool, so a calendar-ish
 * query falls through to `general` rather than promising something the assistant can't do.
 */

export type FillerDomain = "notes" | "paper" | "photos" | "imagegen" | "home" | "activity" | "time" | "general";

/** First match wins, so order = priority. `home`/`imagegen` precede `photos` so "generate an image"
 * and "turn on the light" don't get mis-tagged as a photos query. */
const DOMAIN_PATTERNS: { domain: FillerDomain; re: RegExp }[] = [
  { domain: "home", re: /\b(lights?|lamp|switch|turn (it )?(on|off)|fan|thermostat|temperature|heater|ac\b|plug|outlet|scene|cover|blinds?|lock|unlock|dim|brighten)\b/i },
  { domain: "imagegen", re: /\b(draw|sketch|paint|illustrat\w*|generate (me )?(an? )?(image|picture|photo|art)|create (me )?(an? )?(image|picture)|render (an? )?image)\b/i },
  { domain: "photos", re: /\b(photos?|pictures?|images?|gallery|pics?|selfie|screenshot)\b/i },
  { domain: "paper", re: /\b(understory|newspaper|the paper|today'?s paper|news|headlines?|editions?|articles?)\b/i },
  { domain: "activity", re: /\b(work(ed|ing)? on|been (up to|doing)|on (my |the )?screen|my activity|recent activity|last \d+ (min|minute|hour)|what (was|am) i (doing|working))\b/i },
  { domain: "time", re: /\b(what (time|day)|the time|the date|today'?s date|what'?s the date|clock)\b/i },
  { domain: "notes", re: /\b(notes?|remember|memos?|wrote|jotted|find my|search my|did i (write|say|note|mention)|my (project|budget|plan|idea)s?)\b/i },
];

/** Classify a transcript into a tool domain (keyword match; `general` if nothing fits). */
export function classifyFillerDomain(text: string): FillerDomain {
  const t = (text ?? "").toLowerCase();
  for (const { domain, re } of DOMAIN_PATTERNS) if (re.test(t)) return domain;
  return "general";
}

/** Varied, natural spoken phrases per domain (picked at random so it doesn't repeat). */
export const FILLER_PHRASES: Record<FillerDomain, string[]> = {
  notes: ["Let me dig through private context.", "One sec, searching private context.", "Looking that up in Apple Notes and private context."],
  paper: ["Let me check The Understory.", "Pulling up your paper now.", "Checking your latest edition."],
  photos: ["Let me find those photos.", "Looking through your images.", "One sec, pulling up your photos."],
  imagegen: ["Let me sketch that out.", "Working on that image now.", "Give me a moment to create that."],
  home: ["One sec, checking your devices.", "Let me take care of that.", "On it, sorting that out now."],
  activity: ["Let me see what you've been up to.", "Pulling up your recent activity.", "One sec, reviewing your activity."],
  time: ["Let me check.", "One moment.", "Just a second."],
  general: ["Let me look into that.", "One moment.", "Give me a second.", "Let me think about that."],
};

/** Classify `text` and return a random relevant filler phrase for its domain. */
export function pickFillerPhrase(text: string): string {
  const pool = FILLER_PHRASES[classifyFillerDomain(text)];
  return pool[Math.floor(Math.random() * pool.length)] as string;
}
