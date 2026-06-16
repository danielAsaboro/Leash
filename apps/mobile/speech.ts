/**
 * Pure text helpers for the voice path — ported from apps/web/lib/leash/{speech-text,filler}.ts
 * so the mobile call speaks exactly like the web does. No platform deps (JSC-safe regex).
 *
 *   stripMarkdownForSpeech — flatten markdown to plain prose so Supertonic never reads "asterisk".
 *   segmentSentences       — split a (mid-stream) string into COMPLETE sentences + a trailing
 *                            partial `rest`, so we synthesize/speak sentence 1 while the rest streams.
 *   pickFillerPhrase       — a short, query-relevant spoken filler to mask the think gap.
 */

export function stripMarkdownForSpeech(text: string): string {
  let s = text ?? "";
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, "");
  s = s.replace(/<[^>]*>/g, "");
  s = s.replace(/[<>]/g, " ");
  s = s.replace(/```[^\n]*\n?([\s\S]*?)```/g, "$1");
  s = s.replace(/```/g, "");
  s = s.replace(/`([^`]*)`/g, "$1");
  s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/^[ \t]*#{1,6}[ \t]+/gm, "");
  s = s.replace(/^[ \t]*>+[ \t]?/gm, "");
  s = s.replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+/gm, "");
  s = s.replace(/(\*\*|__)(.*?)\1/g, "$2");
  s = s.replace(/(\*|_)(.*?)\1/g, "$2");
  s = s.replace(/[*_]/g, "");
  s = s.replace(/\|/g, " ");
  s = s.replace(/\s[-–—]\s/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/**
 * Split into COMPLETE sentences (ending `.`/`!`/`?`/`…`, optional close quote, then whitespace)
 * plus the trailing partial `rest`. `text.length - rest.length` = chars consumed (cursor advance).
 */
export function segmentSentences(text: string): { sentences: string[]; rest: string } {
  const s = text ?? "";
  const sentences: string[] = [];
  const re = /[\s\S]*?[.!?…]+["')\]]?(?=\s)/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const sentence = m[0].trim();
    if (sentence) sentences.push(sentence);
    lastIndex = re.lastIndex;
  }
  return { sentences, rest: s.slice(lastIndex) };
}

// ── Query-relevant spoken filler ─────────────────────────────────────────────
type FillerDomain = "notes" | "paper" | "photos" | "imagegen" | "home" | "activity" | "time" | "general";

const DOMAIN_PATTERNS: { domain: FillerDomain; re: RegExp }[] = [
  { domain: "home", re: /\b(lights?|lamp|switch|turn (it )?(on|off)|fan|thermostat|temperature|heater|ac\b|plug|outlet|scene|cover|blinds?|lock|unlock|dim|brighten)\b/i },
  { domain: "imagegen", re: /\b(draw|sketch|paint|illustrat\w*|generate (me )?(an? )?(image|picture|photo|art)|create (me )?(an? )?(image|picture)|render (an? )?image)\b/i },
  { domain: "photos", re: /\b(photos?|pictures?|images?|gallery|pics?|selfie|screenshot)\b/i },
  { domain: "paper", re: /\b(understory|newspaper|the paper|today'?s paper|news|headlines?|editions?|articles?)\b/i },
  { domain: "activity", re: /\b(work(ed|ing)? on|been (up to|doing)|on (my |the )?screen|my activity|recent activity|what (was|am) i (doing|working))\b/i },
  { domain: "time", re: /\b(what (time|day)|the time|the date|today'?s date|what'?s the date|clock)\b/i },
  { domain: "notes", re: /\b(notes?|remember|memos?|wrote|jotted|find my|search my|did i (write|say|note|mention)|my (project|budget|plan|idea)s?)\b/i },
];

const FILLER_PHRASES: Record<FillerDomain, string[]> = {
  notes: ["Let me dig through your notes.", "One sec, searching your notes.", "Looking that up in your notes."],
  paper: ["Let me check The Understory.", "Pulling up your paper now.", "Checking your latest edition."],
  photos: ["Let me find those photos.", "Looking through your images.", "One sec, pulling up your photos."],
  imagegen: ["Let me sketch that out.", "Working on that image now.", "Give me a moment to create that."],
  home: ["One sec, checking your devices.", "Let me take care of that.", "On it, sorting that out now."],
  activity: ["Let me see what you've been up to.", "Pulling up your recent activity.", "One sec, reviewing your activity."],
  time: ["Let me check.", "One moment.", "Just a second."],
  general: ["Let me look into that.", "One moment.", "Give me a second.", "Let me think about that."],
};

function classify(text: string): FillerDomain {
  const t = (text ?? "").toLowerCase();
  for (const { domain, re } of DOMAIN_PATTERNS) if (re.test(t)) return domain;
  return "general";
}

/** A varied, query-relevant filler phrase. `seed` (e.g. a turn counter) varies the pick. */
export function pickFillerPhrase(text: string, seed: number): string {
  const pool = FILLER_PHRASES[classify(text)];
  return pool[seed % pool.length] as string;
}
