/**
 * Pure-logic smoke for the vision-over-mesh content parser (apps/hypha/src/chat-attachments.ts).
 * The shim borrows `vision` over the chat path: OpenAI sends images as `image_url` content
 * parts; this flattens text + collects `data:` images and decodes them to bytes (the shim writes the
 * temp file). Proves text/image splitting, bare-vs-object `image_url`, http URLs ignored, and decode.
 *   npm run smoke:chat-attachments
 */
import assert from "node:assert/strict";
import { flattenContent, parseDataUrlImage } from "../apps/hypha/src/chat-attachments.ts";

const img = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

// string content → text, no images
let r = flattenContent("hello");
assert.equal(r.text, "hello");
assert.equal(r.images.length, 0);

// array: text + image_url (object form, as OpenAI sends)
r = flattenContent([{ type: "text", text: "what is this? " }, { type: "image_url", image_url: { url: img } }]);
assert.equal(r.text, "what is this? ");
assert.deepEqual(r.images, [img]);

// image_url as a bare string (some clients) + a separate text part
r = flattenContent([{ image_url: img }, { text: "x" }]);
assert.deepEqual(r.images, [img]);
assert.equal(r.text, "x");

// http(s) image URL is NOT collected (only data: URLs are materialized)
r = flattenContent([{ image_url: { url: "https://example.com/x.png" } }, { text: "hi" }]);
assert.equal(r.images.length, 0);
assert.equal(r.text, "hi");

// non-array, non-string → empty (defensive)
r = flattenContent(undefined as never);
assert.equal(r.text, "");
assert.equal(r.images.length, 0);

// decode a valid png data URL → ext + non-empty bytes
const p = parseDataUrlImage(img);
assert.ok(p, "png should decode");
assert.equal(p.ext, "png");
assert.ok(p.bytes.length > 0);

// jpeg → ext "jpeg"
const jp = parseDataUrlImage("data:image/jpeg;base64,/9j/4AAQSkZJRg==");
assert.ok(jp);
assert.equal(jp.ext, "jpeg");

// invalid inputs → null
assert.equal(parseDataUrlImage("https://x/y.png"), null);
assert.equal(parseDataUrlImage("data:text/plain;base64,aGk="), null);

console.log("✅ chat-attachments — flatten text+images · bare/object image_url · http ignored · data-URL decode (png/jpeg) · invalid → null — GO");
