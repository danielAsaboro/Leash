/**
 * Tool toggles (server-only) — `data/leash-tools.json`, shape `{ "disabled": [names] }`.
 *
 * Lets the dashboard switch individual assistant tools off without code changes.
 * CRITICAL ORDERING (chat route): `validateUIMessages` must see the FULL registry —
 * stored threads contain parts for now-disabled tools and would fail validation —
 * and only `streamText` gets the filtered set.
 */
import "server-only";
import { join } from "node:path";
import type { ToolSet } from "ai";
import { readJsonCached, writeJson, invalidateJsonCache, DATA_DIR } from "./json-store.ts";

export const TOOLS_FILE = process.env["LEASH_TOOLS_FILE"] ?? join(DATA_DIR, "leash-tools.json");

interface ToolConfig {
  disabled: string[];
}

/** The disabled-tool names (mtime-cached read). */
export async function disabledTools(): Promise<Set<string>> {
  const raw = await readJsonCached<ToolConfig>(TOOLS_FILE, { disabled: [] });
  return new Set(Array.isArray(raw?.disabled) ? raw.disabled.filter((n): n is string => typeof n === "string") : []);
}

/** Persist the disabled set. */
export async function setDisabledTools(names: string[]): Promise<void> {
  await writeJson(TOOLS_FILE, { disabled: [...new Set(names.map((n) => n.trim()).filter(Boolean))].sort() });
  invalidateJsonCache(TOOLS_FILE);
}

/** The registry minus disabled tools — pass THIS (and only this) to `streamText`. */
export async function filterEnabledTools<T extends ToolSet>(tools: T): Promise<ToolSet> {
  const off = await disabledTools();
  if (off.size === 0) return tools;
  return Object.fromEntries(Object.entries(tools).filter(([name]) => !off.has(name)));
}
