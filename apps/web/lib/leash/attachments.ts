/**
 * Inline NON-IMAGE file attachments into the chat model's input as text.
 *
 * The on-device chat model is text-only. Image attachments route to the vision VLM
 * (`isImageTurn`, route.ts) and are left UNTOUCHED here. Every other attached file
 * (markdown, code, JSON, CSV, logs, plain text…) is decoded from its `data:` URL and
 * folded into the user message as a clearly delimited, size-capped text block, so the
 * model can actually read and answer about it. Unreadable binaries (PDF, archives,
 * audio/video) become an HONEST one-line note naming the file — never a silent drop.
 *
 * This operates on the MODEL input only: the stored/displayed thread keeps the original
 * file part (rendered as a chip in the UI). Pure + dependency-free — unit-tested by
 * scripts/smoke-chat-attachments-text.ts.
 */
import type { LeashUIMessage } from "./types.ts";

/** Per-file cap on injected text (~8k tokens) — keeps one attachment from eating the 32k window. */
export const MAX_FILE_CHARS = 32_000;

/** Extensions we treat as plain-text-readable even when the browser hands us an empty/octet MIME. */
const READABLE_EXT = new Set([
  "txt", "text", "md", "markdown", "rst", "org", "tex", "log",
  "json", "jsonl", "ndjson", "json5", "csv", "tsv", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "properties", "env",
  "html", "htm", "css", "scss", "sass", "less",
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts",
  "py", "rb", "go", "rs", "java", "kt", "kts", "swift", "c", "h", "cpp", "cc", "cxx", "hpp", "cs", "php", "scala", "clj", "ex", "exs", "erl", "hs", "lua", "r", "pl", "pm",
  "sh", "bash", "zsh", "fish", "ps1", "bat",
  "sql", "graphql", "gql", "proto", "vue", "svelte", "astro",
  "srt", "vtt", "diff", "patch", "gitignore", "dockerfile", "makefile",
]);

/** A handful of code/text MIME families browsers report that `text/*` misses. */
const READABLE_MIME_RE = /^(?:text\/|application\/(?:json|x?ndjson|xml|xhtml\+xml|javascript|x-javascript|ecmascript|typescript|x-typescript|x-sh|x-shellscript|x-yaml|yaml|toml|sql|graphql|csv|x-csv|x-tex|x-latex|rtf))/i;

/** Filename → lowercased extension (handles `Makefile`/`Dockerfile`, which have no dot). */
function extOf(filename: string): string {
  const name = filename.toLowerCase();
  const special = name.split("/").pop() ?? name;
  if (special === "makefile" || special === "dockerfile" || special === "gitignore") return special;
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1) : "";
}

/** Is this attachment readable as plain text (by MIME family or by a known code/text extension)? */
export function isReadableTextFile(mediaType: string | undefined, filename: string | undefined): boolean {
  const mt = (mediaType ?? "").toLowerCase();
  if (mt.startsWith("image/")) return false;
  if (READABLE_MIME_RE.test(mt)) return true;
  return READABLE_EXT.has(extOf(filename ?? ""));
}

/**
 * Decode a `data:` URL to a UTF-8 string. Handles base64 (`;base64,…` — what FileReader
 * emits) and plain percent-encoded payloads. Returns null if `url` isn't a data URL.
 */
export function decodeDataUrlText(url: string): string | null {
  const m = /^data:([^;,]*)((?:;[^,]*)*),(.*)$/s.exec(url);
  if (!m) return null;
  const meta = m[2] ?? "";
  const payload = m[3] ?? "";
  try {
    if (/;base64/i.test(meta)) return Buffer.from(payload, "base64").toString("utf8");
    return decodeURIComponent(payload);
  } catch {
    return null;
  }
}

/** Cap a decoded body to MAX_FILE_CHARS, appending a truncation marker when it overflows. */
function clamp(body: string): string {
  if (body.length <= MAX_FILE_CHARS) return body;
  return body.slice(0, MAX_FILE_CHARS) + `\n…[truncated — file is ${body.length.toLocaleString()} chars, showing first ${MAX_FILE_CHARS.toLocaleString()}]`;
}

/** A short human label for an attachment we can't read as text (e.g. "report.pdf (application/pdf)"). */
function binaryNote(name: string, mt: string): string {
  const kind = mt ? ` (${mt})` : "";
  return `[Attached file: ${name}${kind} — binary, not readable as text on-device. Attach a text/markdown/CSV version, or ask me about its name and type.]`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Part = any;

/**
 * Rewrite every user message so NON-IMAGE file parts become text. Image parts pass through
 * unchanged (vision path). Text-readable files are inlined as a fenced block; other binaries
 * become an honest note. Returns a NEW message array — the input is not mutated.
 */
export function inlineFileAttachments(messages: LeashUIMessage[]): LeashUIMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "user" || !Array.isArray(msg.parts)) return msg;
    let changed = false;
    const parts: Part[] = [];
    for (const part of msg.parts as Part[]) {
      if (part?.type !== "file") {
        parts.push(part);
        continue;
      }
      const mt = String(part.mediaType ?? "").toLowerCase();
      if (mt.startsWith("image/")) {
        parts.push(part); // vision route handles images
        continue;
      }
      changed = true;
      const name = String(part.filename ?? "file");
      const url = typeof part.url === "string" ? part.url : "";
      const decoded = isReadableTextFile(mt, name) ? decodeDataUrlText(url) : null;
      const text =
        decoded !== null
          ? `\n\n[Attached file: ${name}]\n\`\`\`\n${clamp(decoded)}\n\`\`\`\n`
          : `\n\n${binaryNote(name, mt)}\n`;
      parts.push({ type: "text", text });
    }
    return changed ? { ...msg, parts } : msg;
  });
}
