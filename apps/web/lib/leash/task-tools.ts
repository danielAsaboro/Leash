/**
 * TODO tools for the assistant (server-only) — create_task / list_tasks / update_task
 * over the shared file store (`tasks-store.ts`), so "remind me to…" in chat lands on
 * the Activity dashboard and vice versa. The persisted store keeps its historical task
 * type names; user-facing copy calls these TODOs because they render as checkable items.
 *
 * A factory (not a const registry) because created/updated tasks are stamped with the
 * current `chatId` — the dashboard links a task back to the conversations it came from.
 * Returns `{ text, sources }` like every other Leash tool.
 */
import "server-only";
import { tool } from "ai";
import { z } from "zod";
import { createTask, listTasks, updateTask, TASK_STATUSES, TASK_PRIORITIES, type LeashTask, type TaskStatus, type TaskPriority } from "./tasks-store.ts";
import type { LeashSource } from "./tools.ts";

function fmtTask(t: LeashTask): string {
  const bits = [`[${t.status}]`, t.title, `(id ${t.id}, ${t.priority}${t.tags.length ? `, tags: ${t.tags.join("/")}` : ""})`];
  return bits.join(" ") + (t.detail ? ` — ${t.detail}` : "");
}

/** Slim, UI-facing TODO row carried alongside `text` so the chat can render the official
 *  `Task` component (instead of a JSON dump). Kept small — it rides in the tool result. */
export interface TaskRow {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  detail?: string;
}
const slim = (t: LeashTask): TaskRow => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, ...(t.detail ? { detail: t.detail } : {}) });

/** The three TODO tools, bound to the current chat id. */
export function taskTools(chatId: string) {
  return {
    create_task: tool({
      description:
        "Create a TODO on the user's TODO list (the Activity dashboard). Use when the user asks to be reminded of something, to track a follow-up, or to add a TODO. Keep the title short and actionable.",
      inputSchema: z.object({
        title: z.string().describe("Short, actionable TODO title (e.g. 'Back up the SSD')."),
        detail: z.string().optional().describe("Optional context: why, links, specifics."),
        priority: z.enum(TASK_PRIORITIES as [TaskPriority, ...TaskPriority[]]).optional().describe("Priority (default 'normal')."),
        tags: z.array(z.string()).optional().describe("Optional short tags for filtering."),
      }),
      execute: async ({ title, detail, priority, tags }) => {
        const t = await createTask({ title, detail, priority, tags, source: "assistant", chatId });
        return { text: `Created TODO: ${fmtTask(t)}`, sources: [] as LeashSource[], task: slim(t) };
      },
    }),

    list_tasks: tool({
      description:
        "List the user's TODOs (their TODO list on the Activity dashboard). Use when asked what's on their list, what's open, or before updating a TODO to find its id. Optionally filter by status.",
      inputSchema: z.object({
        status: z.enum(TASK_STATUSES as [TaskStatus, ...TaskStatus[]]).optional().describe("Only tasks with this status (default: all)."),
      }),
      execute: async ({ status }) => {
        const tasks = await listTasks(status ? { status } : {});
        return {
          text: tasks.length
            ? `${tasks.length} TODO(s):\n` + tasks.slice(0, 25).map(fmtTask).join("\n")
            : status
              ? `No ${status} TODOs.`
              : "The TODO list is empty.",
          sources: [] as LeashSource[],
          tasks: tasks.slice(0, 25).map(slim),
        };
      },
    }),

    update_task: tool({
      description:
        "Update a TODO on the user's TODO list: change status (open/in_progress/done/dropped), title, detail, or priority. Use list_tasks first to find the TODO id if you don't have it.",
      inputSchema: z.object({
        id: z.string().describe("The TODO id (from list_tasks or create_task)."),
        status: z.enum(TASK_STATUSES as [TaskStatus, ...TaskStatus[]]).optional().describe("New status (e.g. 'done' to complete it)."),
        title: z.string().optional().describe("New title."),
        detail: z.string().optional().describe("New detail (empty string clears it)."),
        priority: z.enum(TASK_PRIORITIES as [TaskPriority, ...TaskPriority[]]).optional().describe("New priority."),
      }),
      execute: async ({ id, status, title, detail, priority }) => {
        const t = await updateTask(id, { status, title, detail, priority, chatId });
        return {
          text: t ? `Updated TODO: ${fmtTask(t)}` : `No TODO with id "${id}" — use list_tasks to find the right id.`,
          sources: [] as LeashSource[],
          ...(t ? { task: slim(t) } : {}),
        };
      },
    }),
  };
}
