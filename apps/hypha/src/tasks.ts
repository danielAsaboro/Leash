/**
 * Task normalization shared by the hypha mesh controller (main.ts) and its task-sync test, so both
 * exercise the EXACT same path. An HTTP body is a partial MeshTask; this fills the defaults the web
 * may omit and server-stamps `createdAt`/`updatedAt` (the LWW key) when absent.
 */
import type { MeshTask } from "@mycelium/mesh";

export function normalizeTask(input: Partial<MeshTask> & { id: string }, now: number): MeshTask {
  return {
    id: input.id,
    title: input.title ?? "",
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
    status: input.status ?? "open",
    priority: input.priority ?? "normal",
    tags: input.tags ?? [],
    source: input.source ?? "user",
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
    ...(input.deleted ? { deleted: true as const } : {}),
  };
}
