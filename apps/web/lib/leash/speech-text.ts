/**
 * Pure text helpers shared by Leash's voice path (the `/speak` route AND the client
 * VoiceCall queue). No browser or server-only deps — importable from both edges.
 *
 *   stripMarkdownForSpeech — flatten markdown to plain spoken prose so Supertonic never
 *                            reads "asterisk asterisk" / backticks / "#" aloud.
 *   segmentSentences       — split a (possibly mid-stream) string into COMPLETE sentences
 *                            plus the trailing partial `rest`, so we can synthesize +
 *                            speak sentence 1 while the rest is still generating.
 */

/**
 * Strip markdown formatting down to plain prose suitable for text-to-speech. Removes emphasis
 * (`**`/`__`/`*`/`_`), inline + fenced code fences (keeping the code text), headings, blockquote
 * markers, leading list markers, link syntax (`[label](url)` → `label`), table pipes, and
 * spaced dash separators; collapses all whitespace/newlines to single spaces.
 */
export function stripMarkdownForSpeech(text: string): string {
  let s = text ?? "";
  // Fenced code blocks ```lang\n…``` → keep the inner text, drop the fences + language tag.
  s = s.replace(/```[^\n]*\n?([\s\S]*?)```/g, "$1");
  s = s.replace(/```/g, ""); // any stray / unclosed fence
  // Inline code `code` → code.
  s = s.replace(/`([^`]*)`/g, "$1");
  // Images / links: ![alt](url) and [label](url) → the visible label.
  s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
  // ATX headings: leading #'s.
  s = s.replace(/^[ \t]*#{1,6}[ \t]+/gm, "");
  // Blockquote markers.
  s = s.replace(/^[ \t]*>+[ \t]?/gm, "");
  // Leading list markers at line start: -, *, +, or "1.".
  s = s.replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+/gm, "");
  // Emphasis: bold first (paired ** / __), then italic (paired * / _).
  s = s.replace(/(\*\*|__)(.*?)\1/g, "$2");
  s = s.replace(/(\*|_)(.*?)\1/g, "$2");
  // Any remaining stray emphasis characters.
  s = s.replace(/[*_]/g, "");
  // Table pipes → spaces.
  s = s.replace(/\|/g, " ");
  // Spaced dash separators (bullet-style "a - b", en/em dashes) → a single space.
  s = s.replace(/\s[-–—]\s/g, " ");
  // Collapse all whitespace/newlines to single spaces.
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/**
 * Split `text` into COMPLETE sentences (ending in `.`/`!`/`?`/`…`, optional closing quote, then
 * whitespace) and the trailing partial `rest`. `sentences` are trimmed and keep their terminal
 * punctuation; `rest` is the raw, un-consumed remainder (so `text.length - rest.length` is exactly
 * the number of characters consumed — the caller advances its cursor by that amount). A sentence
 * with no trailing whitespace (e.g. the very end of a finished reply) stays in `rest` until flushed.
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
