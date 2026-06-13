/**
 * Memory tool group — `remember` / `recall` over the typed memory store.
 *
 * Provenance note: in-process these were chatId-stamped (one factory per chat). An MCP
 * connection is global (not per-chat), so writes are stamped `source:"assistant"` with NO
 * chatId — the dashboard still shows them as assistant-authored; we just don't link the
 * originating conversation. (A small, honest provenance trade for the grouped-server model.)
 */
import { z } from "zod";
import { addMemory, listMemories, MEMORY_TYPES, type MemoryType, type LeashMemory } from "../memories-store.ts";
import type { LeashSource } from "../sources.ts";
import { defineTool, type ToolGroup } from "./types.ts";

const NO_SOURCES: LeashSource[] = [];

const ago = (ms: number): string => {
  const d = Math.floor((Date.now() - ms) / 86400000);
  return d < 1 ? "today" : d === 1 ? "yesterday" : `${d}d ago`;
};
const fmt = (m: LeashMemory): string => `[${m.type}] ${m.text} (id ${m.id}, ${ago(m.updatedAt)})`;

export const memoryGroup: ToolGroup = {
  id: "memory",
  label: "Memory",
  description: "Save and recall typed memories about the user (preferences, facts, goals, people, routines).",
  tools: [
    defineTool({
      name: "remember",
      description:
        "Save a memory about the user so future conversations know it. Types: 'preference' (how they like things done — these shape your behavior), 'fact' (stable truths about them or their world), 'goal' (something they want to achieve), 'person' (people in their life), 'routine' (recurring patterns). Use when the user states something durable about themselves, asks you to remember something, or corrects you about themselves.",
      inputSchema: {
        type: z.enum(MEMORY_TYPES as [MemoryType, ...MemoryType[]]).describe("The memory's category."),
        text: z.string().describe("One self-contained sentence stating the memory (e.g. 'Prefers metric units')."),
      },
      handler: async ({ type, text }) => {
        const m = await addMemory({ type, text, source: "assistant" });
        return { text: `Remembered ${fmt(m)}`, sources: NO_SOURCES };
      },
    }),

    defineTool({
      name: "recall",
      description:
        "Look up saved memories about the user (their preferences, facts, goals, people, routines). Use before answering questions that depend on what you know about them, or when asked 'what do you know/remember about me'. Optionally filter by type or a keyword.",
      inputSchema: {
        type: z.enum(MEMORY_TYPES as [MemoryType, ...MemoryType[]]).optional().describe("Only memories of this type."),
        query: z.string().optional().describe("Keyword to filter memory texts."),
      },
      handler: async ({ type, query }) => {
        const memories = await listMemories({ type, q: query });
        return {
          text: memories.length
            ? `${memories.length} memor${memories.length === 1 ? "y" : "ies"}:\n` + memories.slice(0, 30).map(fmt).join("\n")
            : "No saved memories match." + (type || query ? " Try without filters." : " Use remember to save some."),
          sources: NO_SOURCES,
        };
      },
    }),
  ],
};
