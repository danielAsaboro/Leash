/**
 * A tiny dependency-free RSS 2.0 / Atom reader.
 *
 * We don't pull a parser library: the feeds we poll (hnrss) are well-formed and we
 * only need title / link / summary / date per item. Regex extraction over the raw
 * XML keeps the dependency surface (and the Apache/MIT license audit) minimal.
 */

export interface FeedItem {
  title: string;
  link: string;
  summary: string;
  published?: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ") // strip any embedded HTML in summaries
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, name: string): string | undefined {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decodeEntities(m[1] ?? "") : undefined;
}

/** Atom <link href="..."/> or RSS <link>...</link>. */
function link(block: string): string {
  const href = block.match(/<link[^>]*href=["']([^"']+)["']/i);
  if (href) return href[1] ?? "";
  return tag(block, "link") ?? "";
}

/** Parse a feed body into items (RSS <item> or Atom <entry>). */
export function parseFeed(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  const blocks = xml.match(/<(item|entry)[\s\S]*?<\/\1>/gi) ?? [];
  for (const block of blocks) {
    const title = tag(block, "title");
    if (!title) continue;
    items.push({
      title,
      link: link(block),
      summary: tag(block, "description") ?? tag(block, "summary") ?? tag(block, "content") ?? "",
      published: tag(block, "pubDate") ?? tag(block, "updated") ?? tag(block, "published"),
    });
  }
  return items;
}

/** Fetch + parse a feed. Throws on network/HTTP error (caller decides offline policy). */
export async function fetchFeed(url: string, timeoutMs = 12_000): Promise<FeedItem[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": "the-understory/0.1 (+mycelium)" } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return parseFeed(await res.text());
  } finally {
    clearTimeout(t);
  }
}

/**
 * Best-effort fetch of an article page's readable text (research grounding).
 * Strips tags/scripts; returns "" on any failure so research stays resilient offline.
 */
export async function fetchReadable(url: string, timeoutMs = 12_000, maxChars = 6000): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": "the-understory/0.1 (+mycelium)" } });
    if (!res.ok) return "";
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z#0-9]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    return text.slice(0, maxChars);
  } catch {
    return "";
  } finally {
    clearTimeout(t);
  }
}
