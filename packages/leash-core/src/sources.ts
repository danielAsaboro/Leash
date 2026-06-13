/**
 * The citation shape every Leash tool returns alongside its `text`. The web UI renders
 * these as AI-Elements "Sources" chips. When a tool lives in the `leash-tools-mcp` daemon,
 * its handler returns this list as MCP `structuredContent.sources` and the web's MCP client
 * (`mcp.ts`) maps it back onto the tool result so citations survive the process boundary.
 */
export interface LeashSource {
  kind: "graph" | "paper";
  title: string;
  snippet: string;
  /** In-app link for paper sources (`/feed/<date>/<slug>`). */
  url?: string;
}

/** The `{ text, sources }` shape returned by every group tool's plain impl function. */
export interface ToolResult {
  text: string;
  sources: LeashSource[];
  /** Some tools carry extra UI payload (e.g. image url, task rows) — passed through verbatim. */
  [extra: string]: unknown;
}

/** Collapse internal whitespace and trim — used to build snippet text. */
export const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
