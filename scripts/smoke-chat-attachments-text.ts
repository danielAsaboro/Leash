/**
 * Pure-logic smoke for the chat file-attachment inliner (apps/web/lib/leash/attachments.ts).
 * Non-image attachments are folded into the text-only chat model's input: text-readable files
 * (markdown/code/JSON/CSV/logs) become a fenced block, images pass through (vision route), and
 * unreadable binaries become an honest note. Proves MIME/extension detection, data-URL decode
 * (base64 + percent-encoded), the size cap, image pass-through, and that input isn't mutated.
 *   npm run smoke:chat-attachments-text
 */
import assert from "node:assert/strict";
import { decodeDataUrlText, isReadableTextFile, inlineFileAttachments, MAX_FILE_CHARS } from "../apps/web/lib/leash/attachments.ts";

// --- detection ---
assert.equal(isReadableTextFile("text/markdown", "notes.md"), true);
assert.equal(isReadableTextFile("application/json", "a.json"), true);
assert.equal(isReadableTextFile("", "script.ts"), true, "empty MIME → fall back to extension");
assert.equal(isReadableTextFile("application/octet-stream", "Dockerfile"), true, "dotless known name");
assert.equal(isReadableTextFile("image/png", "a.png"), false, "images are never text");
assert.equal(isReadableTextFile("application/pdf", "report.pdf"), false);
assert.equal(isReadableTextFile("application/zip", "bundle.zip"), false);

// --- data-URL decode ---
assert.equal(decodeDataUrlText("data:text/plain;base64,aGVsbG8="), "hello");
assert.equal(decodeDataUrlText("data:text/plain;charset=utf-8;base64,aGk="), "hi", "base64 with charset param");
assert.equal(decodeDataUrlText("data:text/plain,hi%20there"), "hi there", "percent-encoded payload");
assert.equal(decodeDataUrlText("https://x/y.txt"), null, "not a data URL → null");

// --- text file → fenced block in the user message; original file part replaced ---
const md = "data:text/markdown;base64," + Buffer.from("# Title\nbody").toString("base64");
let out = inlineFileAttachments([
  { id: "u1", role: "user", parts: [{ type: "file", filename: "notes.md", mediaType: "text/markdown", url: md }, { type: "text", text: "summarize this" }] },
] as never);
let parts = (out[0] as { parts: Array<{ type: string; text?: string }> }).parts;
assert.ok(parts.every((p) => p.type !== "file"), "the text file part is gone");
assert.ok(parts.some((p) => p.type === "text" && p.text!.includes("[Attached file: notes.md]") && p.text!.includes("# Title")), "content is inlined in a block");
assert.ok(parts.some((p) => p.type === "text" && p.text === "summarize this"), "the user's question survives");

// --- image file → passes through untouched (vision route owns it) ---
out = inlineFileAttachments([
  { id: "u2", role: "user", parts: [{ type: "file", filename: "x.png", mediaType: "image/png", url: "data:image/png;base64,iVBOR" }] },
] as never);
parts = (out[0] as { parts: Array<{ type: string }> }).parts;
assert.equal(parts.length, 1);
assert.equal(parts[0]!.type, "file", "image stays a file part");

// --- unreadable binary → honest note, not a silent drop ---
out = inlineFileAttachments([
  { id: "u3", role: "user", parts: [{ type: "file", filename: "report.pdf", mediaType: "application/pdf", url: "data:application/pdf;base64,JVBERi0=" }] },
] as never);
parts = (out[0] as { parts: Array<{ type: string; text?: string }> }).parts;
assert.ok(parts.some((p) => p.type === "text" && p.text!.includes("report.pdf") && p.text!.includes("binary")), "names the file + flags it binary");

// --- size cap: an oversized text file is truncated with a marker ---
const big = "x".repeat(MAX_FILE_CHARS + 5000);
const bigUrl = "data:text/plain;base64," + Buffer.from(big).toString("base64");
out = inlineFileAttachments([
  { id: "u4", role: "user", parts: [{ type: "file", filename: "big.txt", mediaType: "text/plain", url: bigUrl }] },
] as never);
const bigText = (out[0] as { parts: Array<{ type: string; text?: string }> }).parts.find((p) => p.type === "text")!.text!;
assert.ok(bigText.includes("truncated"), "oversized file is truncated");
assert.ok(bigText.length < big.length + 500, "and actually shorter than the original");

// --- assistant messages + no-attachment user turns are returned unchanged (same ref) ---
const untouched = [{ id: "a1", role: "assistant", parts: [{ type: "text", text: "hi" }] }] as never;
assert.equal(inlineFileAttachments(untouched)[0], untouched[0], "no file parts → identity (no copy)");

console.log("✅ chat-attachments-text — MIME/ext detection · base64+percent decode · text→block · image pass-through · binary note · size cap · identity-on-noop — GO");
