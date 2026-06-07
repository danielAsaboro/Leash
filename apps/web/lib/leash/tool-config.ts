/**
 * Tool toggles (server-only) — `data/leash-tools.json`, shape
 * `{ "disabled": [names], "askFirst": { name: boolean } }`.
 *
 * Lets the dashboard switch individual assistant tools off without code changes, and
 * mark tools "Ask first" — the model's call PAUSES on a human approval card in the chat
 * (AI SDK tool approvals). `DEFAULT_ASK_FIRST` covers the two genuinely side-effectful
 * tools (Home Assistant service calls, skill script execution); the `askFirst` map
 * overrides per tool in either direction.
 *
 * CRITICAL ORDERING (chat route): `validateUIMessages` must see the FULL registry —
 * stored threads contain parts for now-disabled tools and would fail validation —
 * and only `streamText` gets the filtered set.
 */
import "server-only";
import { join } from "node:path";
import type { ToolSet } from "ai";
import { readJsonCached, writeJson, invalidateJsonCache, DATA_DIR } from "./json-store.ts";

export const TOOLS_FILE = process.env["LEASH_TOOLS_FILE"] ?? join(DATA_DIR, "leash-tools.json");

/** Tools that pause on a human approval card unless explicitly overridden off. */
export const DEFAULT_ASK_FIRST: ReadonlySet<string> = new Set([
  "ha_call_service",
  "run_skill_script",
  // Computer-use: every side-effectful action on the Mac asks first (screenshot +
  // read_file stay un-gated — see-only / hard-jailed read — but remain toggleable).
  "run_command",
  "write_file",
  "edit_file",
  "computer",
]);

interface ToolConfig {
  disabled: string[];
  askFirst?: Record<string, boolean>;
}

/** The disabled-tool names (mtime-cached read). */
export async function disabledTools(): Promise<Set<string>> {
  const raw = await readJsonCached<ToolConfig>(TOOLS_FILE, { disabled: [] });
  return new Set(Array.isArray(raw?.disabled) ? raw.disabled.filter((n): n is string => typeof n === "string") : []);
}

/** The per-tool "Ask first" override map (mtime-cached read). */
export async function askFirstOverrides(): Promise<Record<string, boolean>> {
  const raw = await readJsonCached<ToolConfig>(TOOLS_FILE, { disabled: [] });
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(raw?.askFirst ?? {})) if (typeof v === "boolean") out[k] = v;
  return out;
}

/** Does `name` need a human approval card right now? (override ?? default) */
export async function toolNeedsApproval(name: string): Promise<boolean> {
  const overrides = await askFirstOverrides();
  return overrides[name] ?? DEFAULT_ASK_FIRST.has(name);
}

/** Persist the disabled set (preserves the askFirst map). */
export async function setDisabledTools(names: string[]): Promise<void> {
  const raw = await readJsonCached<ToolConfig>(TOOLS_FILE, { disabled: [] });
  await writeJson(TOOLS_FILE, {
    disabled: [...new Set(names.map((n) => n.trim()).filter(Boolean))].sort(),
    ...(raw?.askFirst && Object.keys(raw.askFirst).length > 0 ? { askFirst: raw.askFirst } : {}),
  });
  invalidateJsonCache(TOOLS_FILE);
}

/** Persist Ask-first overrides (merge; an entry equal to the default is dropped). */
export async function setAskFirst(overrides: Record<string, boolean>): Promise<void> {
  const raw = await readJsonCached<ToolConfig>(TOOLS_FILE, { disabled: [] });
  const merged: Record<string, boolean> = { ...(raw?.askFirst ?? {}) };
  for (const [name, v] of Object.entries(overrides)) {
    if (typeof v !== "boolean" || !name.trim()) continue;
    if (v === DEFAULT_ASK_FIRST.has(name)) delete merged[name]; // back to default → no override row
    else merged[name] = v;
  }
  await writeJson(TOOLS_FILE, {
    disabled: Array.isArray(raw?.disabled) ? raw.disabled : [],
    ...(Object.keys(merged).length > 0 ? { askFirst: merged } : {}),
  });
  invalidateJsonCache(TOOLS_FILE);
}

/** The registry minus disabled tools — pass THIS (and only this) to `streamText`. */
export async function filterEnabledTools<T extends ToolSet>(tools: T): Promise<ToolSet> {
  const off = await disabledTools();
  if (off.size === 0) return tools;
  return Object.fromEntries(Object.entries(tools).filter(([name]) => !off.has(name)));
}

/**
 * Attach `needsApproval` gates: each tool reads the CURRENT config at call time
 * (an async fn, not a frozen boolean) so a dashboard toggle applies on the next turn
 * without restarting anything.
 */
export function withApprovalGates(tools: ToolSet): ToolSet {
  return Object.fromEntries(Object.entries(tools).map(([name, t]) => [name, { ...t, needsApproval: () => toolNeedsApproval(name) }]));
}
