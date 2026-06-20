/**
 * Todos tool group — create / list / update todos on the user's /tasks dashboard.
 *
 * Provenance note (same as Memory): writes are stamped `source:"assistant"` with NO chatId,
 * since an MCP connection isn't per-chat. The slim `task`/`tasks` rows ride along as extras
 * so the chat can render the official Task component (the web MCP client surfaces them).
 */
import { z } from "zod";
import { createTask, listTasks, updateTask, TASK_STATUSES, TASK_PRIORITIES, type LeashTask, type TaskStatus, type TaskPriority } from "../tasks-store.ts";
import type { LeashSource } from "../sources.ts";
import { defineTool, type ToolGroup } from "./types.ts";

const NO_SOURCES: LeashSource[] = [];

interface TaskRow {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  detail?: string;
}
const slim = (t: LeashTask): TaskRow => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, ...(t.detail ? { detail: t.detail } : {}) });

function fmtTask(t: LeashTask): string {
  const bits = [`[${t.status}]`, t.title, `(id ${t.id}, ${t.priority}${t.tags.length ? `, tags: ${t.tags.join("/")}` : ""})`];
  return bits.join(" ") + (t.detail ? ` — ${t.detail}` : "");
}

export const tasksGroup: ToolGroup = {
  id: "tasks",
  label: "Todos",
  description: "Create, list, and update todos on the user's todo list (the /tasks dashboard).",
  tools: [
    defineTool({
      name: "create_task",
      description:
        "Create a todo on the user's todo list (the /tasks dashboard). Use when the user asks to be reminded of something, to track a follow-up, or to add a todo. Keep the title short and actionable.",
      inputSchema: {
        title: z.string().describe("Short, actionable todo title (e.g. 'Back up the SSD')."),
        detail: z.string().optional().describe("Optional context: why, links, specifics."),
        priority: z.enum(TASK_PRIORITIES as [TaskPriority, ...TaskPriority[]]).optional().describe("Priority (default 'normal')."),
        tags: z.array(z.string()).optional().describe("Optional short tags for filtering."),
      },
      handler: async ({ title, detail, priority, tags }) => {
        const t = await createTask({ title, detail, priority, tags, source: "assistant" });
        return { text: `Created todo: ${fmtTask(t)}`, sources: NO_SOURCES, task: slim(t) };
      },
    }),

    defineTool({
      name: "list_tasks",
      description:
        "List the user's todos (their todo list on the /tasks dashboard). Use when asked what's on their list, what's open, or before updating a todo to find its id. Optionally filter by status.",
      inputSchema: {
        status: z.enum(TASK_STATUSES as [TaskStatus, ...TaskStatus[]]).optional().describe("Only tasks with this status (default: all)."),
      },
      handler: async ({ status }) => {
        const tasks = await listTasks(status ? { status } : {});
        return {
          text: tasks.length
            ? `${tasks.length} todo(s):\n` + tasks.slice(0, 25).map(fmtTask).join("\n")
            : status
              ? `No ${status} todos.`
              : "The todo list is empty.",
          sources: NO_SOURCES,
          tasks: tasks.slice(0, 25).map(slim),
        };
      },
    }),

    defineTool({
      name: "update_task",
      description:
        "Update a todo on the user's todo list: change status (open/in_progress/done/dropped), title, detail, or priority. Use list_tasks first to find the todo id if you don't have it.",
      inputSchema: {
        id: z.string().describe("The todo id (from list_tasks or create_task)."),
        status: z.enum(TASK_STATUSES as [TaskStatus, ...TaskStatus[]]).optional().describe("New status (e.g. 'done' to complete it)."),
        title: z.string().optional().describe("New title."),
        detail: z.string().optional().describe("New detail (empty string clears it)."),
        priority: z.enum(TASK_PRIORITIES as [TaskPriority, ...TaskPriority[]]).optional().describe("New priority."),
      },
      handler: async ({ id, status, title, detail, priority }) => {
        const t = await updateTask(id, { status, title, detail, priority });
        return {
          text: t ? `Updated todo: ${fmtTask(t)}` : `No todo with id "${id}" — use list_tasks to find the right id.`,
          sources: NO_SOURCES,
          ...(t ? { task: slim(t) } : {}),
        };
      },
    }),
  ],
};
