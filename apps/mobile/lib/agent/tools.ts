/**
 * The on-device tool set — runnable entirely on the phone, no server, no mesh required.
 *
 * Mirrors the spirit of the web's task/memory tools but bound to the mobile stores: tasks ride the
 * mesh-replicated CRDT (`tasks.ts` → `meshClient.upsertTask`), local text entries and memories stay on-device, plus a
 * `get_current_time`. These are the multi-step loop's hands; `buildLeashAgent` runs them up to its
 * step cap. Each `execute` returns a compact JSON-able result so the Tool card renders cleanly.
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { listTasks, createTask, updateTask, deleteTask, type TaskStatus } from "../../tasks";
import { listNotes, loadNote, saveNote, newNoteId } from "../../notes";
import { listMemories, addMemory } from "../../memories";

export const MOBILE_TOOL_CATALOG = [
  { name: "get_current_time", description: "Get the current date and time on this device." },
  { name: "list_tasks", description: "List the user's tasks, optionally filtered by status." },
  { name: "add_task", description: "Create a new task for the user." },
  { name: "complete_task", description: "Mark a task as done by its id." },
  { name: "delete_task", description: "Delete a task by its id." },
  { name: "search_notes", description: "Search the user's notes by a query." },
  { name: "create_note", description: "Save a new note with a title and body." },
  { name: "remember", description: "Store a long-term memory about the user." },
  { name: "list_memories", description: "List everything the assistant has remembered about the user." },
] as const;

export function buildDeviceTools(): ToolSet {
  return {
    get_current_time: tool({
      description: "Get the current date and time on this device.",
      inputSchema: z.object({}),
      execute: async () => {
        const d = new Date();
        return { iso: d.toISOString(), local: d.toString() };
      },
    }),

    list_tasks: tool({
      description: "List the user's tasks, optionally filtered by status.",
      inputSchema: z.object({
        status: z.enum(["open", "in_progress", "done", "dropped", "all"]).optional().describe("Filter; defaults to all."),
      }),
      execute: async ({ status }) => {
        const tasks = await listTasks((status as TaskStatus | "all" | undefined) ?? "all");
        return { count: tasks.length, tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority })) };
      },
    }),

    add_task: tool({
      description: "Create a new task for the user. Replicates to the device mesh automatically.",
      inputSchema: z.object({
        title: z.string().describe("Short task title."),
        detail: z.string().optional().describe("Optional longer description."),
        priority: z.enum(["low", "normal", "high"]).optional(),
      }),
      execute: async ({ title, detail, priority }) => {
        const t = await createTask({ title, detail, priority, source: "assistant" });
        return { id: t.id, title: t.title, status: t.status, priority: t.priority };
      },
    }),

    complete_task: tool({
      description: "Mark a task as done by its id (get ids from list_tasks first).",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        await updateTask(id, { status: "done" });
        return { id, status: "done" };
      },
    }),

    delete_task: tool({
      description: "Delete a task by its id.",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        await deleteTask(id);
        return { id, deleted: true };
      },
    }),

    search_notes: tool({
      description: "Search the user's notes by a query (matches title and body); returns matching note summaries.",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        const q = query.trim().toLowerCase();
        const summaries = await listNotes();
        const hits: { id: string; title: string }[] = [];
        for (const s of summaries) {
          if (s.title.toLowerCase().includes(q)) {
            hits.push({ id: s.id, title: s.title });
            continue;
          }
          const note = await loadNote(s.id);
          if (note && note.body.toLowerCase().includes(q)) hits.push({ id: s.id, title: s.title });
        }
        return { count: hits.length, notes: hits.slice(0, 10) };
      },
    }),

    create_note: tool({
      description: "Save a new note with a title and body.",
      inputSchema: z.object({ title: z.string(), body: z.string() }),
      execute: async ({ title, body }) => {
        const n = await saveNote({ id: newNoteId(), title, body });
        return { id: n.id, title: n.title };
      },
    }),

    remember: tool({
      description: "Store a long-term memory about the user — a 'preference' (how they like things) or a 'fact' (something true about them).",
      inputSchema: z.object({
        type: z.enum(["preference", "fact"]),
        text: z.string().describe("The memory, written as a concise statement."),
      }),
      execute: async ({ type, text }) => {
        const m = await addMemory(type, text);
        return { id: m.id, type: m.type };
      },
    }),

    list_memories: tool({
      description: "List everything the assistant has remembered about the user.",
      inputSchema: z.object({}),
      execute: async () => {
        const mems = await listMemories();
        return { count: mems.length, memories: mems.map((m) => ({ type: m.type, text: m.text })) };
      },
    }),
  };
}
