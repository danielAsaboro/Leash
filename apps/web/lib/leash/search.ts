/**
 * Keyless web search + readable-text fetch — the deep-research data source. No API
 * keys, no new deps.
 *
 * NOT marked `server-only`: it holds no secrets (pure fetch + HTML parsing) and is
 * imported BOTH by Next routes and by the spawned tsx research child
 * (`scripts/leash-research.mts`), which can't resolve Next's `server-only` shim.
 *
 * "Bypassing Google restrictions" (the PewDiePie/Odysseus trick) is simply: don't use
 * Google's gated Custom Search API or paid Tavily/Serper. Instead:
 *   · default — scrape DuckDuckGo's HTML endpoint (`html.duckduckgo.com/html/`) and
 *     resolve its `/l/?uddg=` redirect links to real URLs (adapted from Odysseus
 *     `services/search/providers.py`)
 *   · optional — a self-hosted SearXNG instance (JSON API) when `LEASH_SEARXNG_URL`
 *     is set: more private and robust, but you must run one
 *
 * This is an ONLINE feature — unlike the local assistant, deep research needs network
 * (like the first model download). All parsing is hand-rolled regex over the HTML, so
 * no `cheerio`/`jsdom` dependency enters the tree.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const SEARXNG_URL = (process.env["LEASH_SEARXNG_URL"] ?? "").trim().replace(/\/+$/, "");

const decode = (s: string): string =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");

const stripTags = (s: string): string => decode(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** Resolve a DuckDuckGo `/l/?uddg=<url>` redirect to its destination. */
function resolveDdg(href: string): string {
  if (!href) return href;
  let h = href;
  if (h.startsWith("//")) h = "https:" + h;
  try {
    const u = new URL(h, "https://html.duckduckgo.com");
    if ((u.hostname === "duckduckgo.com" || u.hostname.endsWith(".duckduckgo.com")) && u.pathname.replace(/\/$/, "") === "/l") {
      const dest = u.searchParams.get("uddg");
      if (dest) return dest;
    }
    return u.href;
  } catch {
    return h;
  }
}

/** SearXNG JSON search (English-pinned, like Odysseus). */
async function searxng(query: string, count: number): Promise<SearchResult[]> {
  const u = new URL(`${SEARXNG_URL}/search`);
  u.search = new URLSearchParams({ q: query, format: "json", language: "en", safesearch: "0" }).toString();
  const res = await fetch(u, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`SearXNG ${res.status}`);
  const body = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
  return (body.results ?? [])
    .filter((r) => r.url)
    .slice(0, count)
    .map((r) => ({ title: r.title ?? "", url: r.url as string, snippet: r.content ?? "" }));
}

/** DuckDuckGo HTML scrape — no key, the default path. */
async function duckduckgo(query: string, count: number): Promise<SearchResult[]> {
  const u = new URL("https://html.duckduckgo.com/html/");
  u.search = new URLSearchParams({ q: query, kp: "-2" }).toString(); // kp=-2 → safesearch off
  const res = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`DuckDuckGo ${res.status}`);
  const html = await res.text();
  const out: SearchResult[] = [];
  // Each result anchor: <a class="result__a" href="...">title</a>; snippets follow in
  // a .result__snippet. Pair them positionally.
  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snipRe.exec(html))) snippets.push(stripTags(sm[1] as string));
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = linkRe.exec(html)) && out.length < count) {
    const url = resolveDdg(decode(m[1] as string));
    const title = stripTags(m[2] as string);
    if (!url || !/^https?:/.test(url)) {
      i++;
      continue;
    }
    out.push({ title, url, snippet: snippets[i] ?? "" });
    i++;
  }
  return out;
}

export interface SearchOutcome {
  results: SearchResult[];
  provider: "searxng" | "duckduckgo";
  /** Honest note when a provider failed or returned nothing. */
  note?: string;
}

/** Web search: SearXNG when configured, else DuckDuckGo HTML; honest on failure. */
export async function webSearch(query: string, count = 8): Promise<SearchOutcome> {
  if (SEARXNG_URL) {
    try {
      const results = await searxng(query, count);
      if (results.length) return { results, provider: "searxng" };
      return { results: [], provider: "searxng", note: "SearXNG returned no results." };
    } catch (err) {
      // Fall through to DDG, but say so.
      try {
        const results = await duckduckgo(query, count);
        return { results, provider: "duckduckgo", note: `SearXNG failed (${err instanceof Error ? err.message : err}); used DuckDuckGo.` };
      } catch (err2) {
        return { results: [], provider: "duckduckgo", note: `Both SearXNG and DuckDuckGo failed: ${err2 instanceof Error ? err2.message : err2}` };
      }
    }
  }
  try {
    const results = await duckduckgo(query, count);
    return { results, provider: "duckduckgo", note: results.length ? undefined : "DuckDuckGo returned no results (it may be rate-limiting)." };
  } catch (err) {
    return { results: [], provider: "duckduckgo", note: `DuckDuckGo search failed: ${err instanceof Error ? err.message : err}` };
  }
}

/**
 * Fetch a page and reduce it to readable plain text (script/style/nav stripped),
 * capped. Best-effort: returns "" on any failure so the research loop just skips it.
 */
export async function fetchReadable(url: string, maxChars = 15_000): Promise<string> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,*/*" }, signal: AbortSignal.timeout(15_000), redirect: "follow" });
    if (!res.ok) return "";
    const ct = res.headers.get("content-type") ?? "";
    if (!/text\/html|text\/plain|application\/xhtml/.test(ct)) return "";
    let html = await res.text();
    // Drop the noisy non-content elements wholesale.
    html = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<(nav|header|footer|aside|form|svg)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ");
    const text = stripTags(html);
    return text.length > maxChars ? text.slice(0, maxChars) + " …(truncated)" : text;
  } catch {
    return "";
  }
}
