/**
 * Context tool group — the user's private context graph + live screen-activity trail.
 *
 *   · search_graph     — RAG over private context + activity + typed memories + past chats (QVAC embeds)
 *   · active_context   — what the user is doing on their screen right now
 *   · activity_recent  — the user's screen activity over the last N minutes
 */
import { z } from "zod";
import { searchNotes, readActivityRecords, type ActivityRecord } from "../graph.ts";
import { oneLine, type LeashSource } from "../sources.ts";
import { defineTool, type ToolGroup } from "./types.ts";

const NO_SOURCES: LeashSource[] = [];

/** "12m ago" / "just now" from an ISO timestamp. */
function agoLabel(ts: string): string {
  const then = new Date(ts).getTime();
  if (Number.isNaN(then)) return "recently";
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  return mins <= 0 ? "just now" : `${mins}m ago`;
}

/** Local HH:MM from an ISO timestamp (for timeline lines). */
function hhmm(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "--:--";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export const contextGroup: ToolGroup = {
  id: "context",
  label: "Context",
  description: "Search the user's private context graph (Apple Notes, files, memories, past chats) and read their live screen-activity trail.",
  tools: [
    defineTool({
      name: "search_graph",
      description:
        "Search the user's private context graph (Apple Notes, files, voice memos, and past conversations with you) for passages relevant to a query. Call this whenever answering needs private facts about the user, their devices, projects, preferences, or what was said in an earlier chat — do not guess.",
      inputSchema: {
        query: z.string().describe("Natural-language description of the information needed."),
        topK: z.number().int().min(1).max(8).optional().describe("How many snippets to retrieve (default 3)."),
      },
      handler: async ({ query, topK }) => {
        const hits = await searchNotes(query, topK ?? 3);
        const sources: LeashSource[] = hits.map((h) => ({ kind: "graph", title: `Context · ${h.source}`, snippet: oneLine(h.text).slice(0, 200) }));
        return {
          text: hits.length ? hits.map((h) => `(${h.source}) ${oneLine(h.text)}`).join("\n---\n") : "No matching passages in the user's private context.",
          sources,
        };
      },
    }),

    defineTool({
      name: "active_context",
      description:
        "What the user is doing on their screen RIGHT NOW, from the on-device screen watcher (`npm run watch`). Use for 'what am I doing?' / 'what's on my screen?'. Returns the most recent observed app, window, and a one-line summary.",
      inputSchema: {},
      handler: async () => {
        const records = await readActivityRecords();
        if (records.length === 0) {
          return { text: "No screen activity recorded yet. Start the watcher with `npm run watch` (and grant Screen Recording).", sources: NO_SOURCES };
        }
        const r = records[records.length - 1] as ActivityRecord;
        const window = r.window ? ` (${r.window})` : "";
        const tags = Array.isArray(r.tags) && r.tags.length ? ` [${r.tags.join(", ")}]` : "";
        const text = `As of ${agoLabel(r.ts)} — ${r.app}${window}: ${r.summary}${tags}`;
        const sources: LeashSource[] = [{ kind: "graph", title: `Activity · ${r.app} ${hhmm(r.ts)}`, snippet: oneLine(r.summary).slice(0, 200) }];
        return { text, sources };
      },
    }),

    defineTool({
      name: "activity_recent",
      description:
        "The user's screen activity over the last N minutes, from the on-device screen watcher. Use for 'what have I been working on?' / 'summarize the last 30 minutes'. Returns a timeline of observed apps and tasks.",
      inputSchema: {
        minutes: z.number().int().min(1).max(1440).optional().describe("How far back to look, in minutes (default 30)."),
      },
      handler: async ({ minutes }) => {
        const window = minutes ?? 30;
        const cutoff = Date.now() - window * 60000;
        const records = await readActivityRecords();
        if (records.length === 0) {
          return { text: "No screen activity recorded yet. Start the watcher with `npm run watch` (and grant Screen Recording).", sources: NO_SOURCES };
        }
        const recent = records.filter((r) => new Date(r.ts).getTime() >= cutoff);
        if (recent.length === 0) return { text: `No screen activity in the last ${window} minutes.`, sources: NO_SOURCES };
        const lines = recent.map((r) => {
          const win = r.window ? ` — ${r.window}` : "";
          return `${hhmm(r.ts)} ${r.app}${win}: ${r.summary}`;
        });
        const sources: LeashSource[] = recent.slice(-5).map((r) => ({ kind: "graph", title: `Activity · ${r.app} ${hhmm(r.ts)}`, snippet: oneLine(r.summary).slice(0, 200) }));
        return { text: `Activity in the last ${window} minutes (${recent.length} observations):\n${lines.join("\n")}`, sources };
      },
    }),
  ],
};
