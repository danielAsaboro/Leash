/**
 * leash-append-task — the shell-task entry the SCHEDULER (mcp-cron) runs for a `task`
 * schedule kind: append one row to the shared task store. Replaces leash-cron's
 * in-process `fireTask`, but calls the CANONICAL `@mycelium/leash-core` task store
 * (file-locked, validated, migration-aware) instead of hand-rolling the file write —
 * the same store the dashboard and assistant read/write.
 *
 *   npx tsx apps/web/scripts/leash-append-task.mts "<title>" ["<detail>"] ["<priority>"] ["tag1,tag2"]
 *
 * Reads LEASH_TASKS_FILE / LEASH_DATA_DIR from the inherited scope env (the store
 * resolves the right per-user file). source is "cron".
 */
import { createTask, TASK_PRIORITIES, type TaskPriority } from "@mycelium/leash-core/tasks-store";

const [, , titleArg, detailArg, priorityArg, tagsArg] = process.argv;

const title = (titleArg ?? "").trim();
if (!title) {
  process.stderr.write("usage: leash-append-task.mts <title> [detail] [priority] [tags]\n");
  process.exit(1);
}

const priority: TaskPriority | undefined = priorityArg && TASK_PRIORITIES.includes(priorityArg as TaskPriority) ? (priorityArg as TaskPriority) : undefined;
const tags = (tagsArg ?? "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

try {
  const task = await createTask({
    title,
    ...(detailArg?.trim() ? { detail: detailArg.trim() } : {}),
    ...(priority ? { priority } : {}),
    ...(tags.length ? { tags } : {}),
    source: "cron",
  });
  process.stdout.write(`created task ${task.id}: ${task.title}\n`);
  process.exit(0);
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
