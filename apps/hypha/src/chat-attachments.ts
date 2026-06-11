/**
 * Pure content parsing for VISION borrowing over the chat path (SP2 / A2). An OpenAI
 * `/v1/chat/completions` message carries images as `image_url` content parts; the delegated
 * `completion()` wants `attachments:[{path}]`. This module flattens text + collects `data:` image
 * URLs and decodes them to bytes; the shim writes the temp file and passes the path. No fs, no SDK —
 * unit-tested by scripts/smoke-chat-attachments.ts.
 */
export interface ContentPart {
  type?: string;
  text?: string;
  image_url?: { url?: string } | string;
}

/** Flatten a message's content to text + the list of inline `data:` image URLs (http URLs ignored). */
export function flattenContent(content: string | ContentPart[]): { text: string; images: string[] } {
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: "", images: [] };
  let text = "";
  const images: string[] = [];
  for (const p of content) {
    if (typeof p?.text === "string") text += p.text;
    const url = typeof p?.image_url === "string" ? p.image_url : p?.image_url?.url;
    if (typeof url === "string" && url.startsWith("data:image/")) images.push(url);
  }
  return { text, images };
}

/** Decode a base64 `data:image/...` URL to its file extension + bytes, or null if it isn't one. */
export function parseDataUrlImage(url: string): { ext: string; bytes: Buffer } | null {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(url);
  if (!m) return null;
  const ext = (m[1]!.split("/")[1] || "png").replace(/[^a-z0-9]/gi, "") || "png";
  return { ext, bytes: Buffer.from(m[2]!, "base64") };
}
