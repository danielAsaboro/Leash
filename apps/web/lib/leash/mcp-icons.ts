/**
 * MCP icon metadata (server-only) — resolves the OPTIONAL `icons` an MCP server advertises
 * on its `serverInfo` and on each tool (MCP spec SEP-973, stable 2025-11-25) into a small,
 * inline, OFFLINE-SAFE data URI the dashboard can render.
 *
 * Why this lives apart from `mcp.ts`: `@ai-sdk/mcp` parses tool/server payloads with
 * `.loose()` schemas, so the `icons` array survives on the wire object but is DROPPED when
 * it builds the AI-SDK ToolSet. Rather than hand-roll a parser, we re-validate that raw
 * array with the OFFICIAL `@modelcontextprotocol/sdk` `IconSchema` (same hoisted zod), then
 * fetch-once-and-cache the chosen icon's bytes so every later read renders with NO network
 * (honors the offline-first rule — first connect warms the cache, airplane mode reuses it).
 *
 * Security: icons are rendered ONLY via `<img src=…>` (never inlined into the DOM), so a
 * malicious SVG cannot execute script. We additionally accept only http(s)/`data:` sources,
 * require an `image/*` content-type, and cap the byte size.
 */
import "server-only";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { z } from "zod";
import { IconSchema } from "@modelcontextprotocol/sdk/types.js";
import { readJson, writeJson, DATA_DIR } from "./json-store.ts";

export type McpIcon = z.infer<typeof IconSchema>;

/** Fetched icon bytes, memoized as base64 data URIs keyed by sha256(src). Per-machine (`data/` is not synced). */
const ICON_CACHE_FILE = process.env["LEASH_MCP_ICON_FILE"] ?? join(DATA_DIR, "leash-mcp-icons.json");
/** Bound a single icon fetch — cosmetic data must never stall a connect. */
const ICON_FETCH_TIMEOUT_MS = 4_000;
/** Reject icons larger than this (raw bytes); they bloat the status JSON and brand marks are tiny. */
const MAX_ICON_BYTES = 128 * 1024;
/** Target render size (px) the scorer optimizes toward — the dashboard draws icons ~16–18px. */
const TARGET_PX = 32;

/** Validate an untyped `icons` value (off a loose-parsed serverInfo/tool) with the official Icon schema. */
export function parseIcons(raw: unknown): McpIcon[] {
  if (!Array.isArray(raw)) return [];
  const out: McpIcon[] = [];
  for (const item of raw) {
    const parsed = IconSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** Rank an icon for a light-background, small target: prefer themeless/light + scalable or near-target raster. */
function scoreIcon(icon: McpIcon): number {
  let score = 0;
  if (icon.theme === undefined) score += 2; // themeless renders anywhere
  else if (icon.theme === "light") score += 1; // dashboard is a light surface
  else score -= 1; // dark-only mark on a light background
  const sizes = icon.sizes ?? [];
  if (sizes.includes("any")) score += 2; // scalable (e.g. SVG) — crisp at any size
  else {
    const px = sizes.map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n));
    if (px.length) {
      const closest = px.reduce((a, b) => (Math.abs(b - TARGET_PX) < Math.abs(a - TARGET_PX) ? b : a));
      score += Math.max(0, 2 - Math.abs(closest - TARGET_PX) / TARGET_PX);
    }
  }
  return score;
}

// In-memory mirror of the disk cache (hash → data URI), loaded once per process.
let memCache: Record<string, string> | null = null;
async function loadCache(): Promise<Record<string, string>> {
  if (!memCache) memCache = await readJson<Record<string, string>>(ICON_CACHE_FILE, {});
  return memCache;
}

/** Largest inline `data:` icon we'll echo back (chars) — uploads are downscaled far below this. */
const MAX_DATA_URI_CHARS = 700_000;

/**
 * Resolve an icon `src` (data: URI or http(s) URL) to a renderable, cached data URI, or undefined
 * on any failure. Shared by server-advertised icons and user-chosen icons.
 */
export async function resolveIconSrc(src: string, mimeType?: string): Promise<string | undefined> {
  // Already inline: trust only (bounded) image data URIs and hand them straight back — no fetch, offline-safe.
  if (src.startsWith("data:")) return /^data:image\//i.test(src) && src.length <= MAX_DATA_URI_CHARS ? src : undefined;
  if (!/^https?:\/\//i.test(src)) return undefined; // reject file:, etc.
  const key = createHash("sha256").update(src).digest("hex");
  const cache = await loadCache();
  if (cache[key]) return cache[key];
  try {
    const res = await fetch(src, { signal: AbortSignal.timeout(ICON_FETCH_TIMEOUT_MS) });
    if (!res.ok) return undefined;
    const ct = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    const declared = mimeType?.toLowerCase() ?? "";
    const mime = ct.startsWith("image/") ? ct : declared.startsWith("image/") ? declared : undefined;
    if (!mime) return undefined; // not an image (e.g. an HTML error page) — don't embed it
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_ICON_BYTES) return undefined;
    const dataUri = `data:${mime};base64,${buf.toString("base64")}`;
    cache[key] = dataUri;
    await writeJson(ICON_CACHE_FILE, cache);
    return dataUri;
  } catch {
    return undefined; // offline / timeout / bad host → caller falls back to a placeholder
  }
}

/** Fetch one advertised icon's bytes → cached data URI, or undefined on ANY failure. */
async function resolveOne(icon: McpIcon): Promise<string | undefined> {
  return resolveIconSrc(icon.src, icon.mimeType);
}

/** Resolve a USER-chosen icon (image URL or uploaded data URI) to a cached, offline-safe data URI. */
export async function resolveUserIcon(input: string): Promise<string | undefined> {
  return resolveIconSrc(input);
}

/**
 * Pick the best of an icon set and resolve it to a renderable data URI, falling through to
 * the next-best icon if the top choice can't be fetched. Returns undefined → use a placeholder.
 */
export async function resolveBestIcon(icons: McpIcon[]): Promise<string | undefined> {
  if (!icons.length) return undefined;
  const ranked = [...icons].sort((a, b) => scoreIcon(b) - scoreIcon(a));
  for (const icon of ranked) {
    const uri = await resolveOne(icon);
    if (uri) return uri;
  }
  return undefined;
}
