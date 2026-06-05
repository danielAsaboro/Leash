/**
 * Memory tools for the assistant (server-only) — `remember` / `recall` over the typed
 * memory store. A factory (chatId-stamped, like task-tools) so every saved memory
 * links back to the conversation it came from.
 */
import "server-only";
import { tool } from "ai";
import { z } from "zod";
import { addMemory, listMemories, MEMORY_TYPES, type MemoryType, type LeashMemory } from "./memories-store.ts";
import type { LeashSource } from "./tools.ts";

const ago = (ms: number): string => {
  const d = Math.floor((Date.now() - ms) / 86400000);
  return d < 1 ? "today" : d === 1 ? "yesterday" : `${d}d ago`;
};

const fmt = (m: LeashMemory): string => `[${m.type}] ${m.text} (id ${m.id}, ${ago(m.updatedAt)})`;

/** The two memory tools, bound to the current chat id. */
export function memoryTools(chatId: string) {
  return {
    remember: tool({
      description:
        "Save a memory about the user so future conversations know it. Types: 'preference' (how they like things done — these shape your behavior), 'fact' (stable truths about them or their world), 'goal' (something they want to achieve), 'person' (people in their life), 'routine' (recurring patterns). Use when the user states something durable about themselves, asks you to remember something, or corrects you about themselves.",
      inputSchema: z.object({
        type: z.enum(MEMORY_TYPES as [MemoryType, ...MemoryType[]]).describe("The memory's category."),
        text: z.string().describe("One self-contained sentence stating the memory (e.g. 'Prefers metric units')."),
      }),
      execute: async ({ type, text }) => {
        const m = await addMemory({ type, text, source: "assistant", chatId });
        return { text: `Remembered ${fmt(m)}`, sources: [] as LeashSource[] };
      },
    }),

    recall: tool({
      description:
        "Look up saved memories about the user (their preferences, facts, goals, people, routines). Use before answering questions that depend on what you know about them, or when asked 'what do you know/remember about me'. Optionally filter by type or a keyword.",
      inputSchema: z.object({
        type: z.enum(MEMORY_TYPES as [MemoryType, ...MemoryType[]]).optional().describe("Only memories of this type."),
        query: z.string().optional().describe("Keyword to filter memory texts."),
      }),
      execute: async ({ type, query }) => {
        const memories = await listMemories({ type, q: query });
        return {
          text: memories.length
            ? `${memories.length} memor${memories.length === 1 ? "y" : "ies"}:\n` + memories.slice(0, 30).map(fmt).join("\n")
            : "No saved memories match." + (type || query ? " Try without filters." : " Use remember to save some."),
          sources: [] as LeashSource[],
        };
      },
    }),
  };
}
