/**
 * JSON repair for model output — small local models (`chat`, medpsy) emit JSON with
 * trailing commas, single quotes, unquoted keys, or truncated tails. Two surfaces:
 *
 *   · `safeParseJson` — strict `JSON.parse` first, `jsonrepair` fallback, never throws.
 *     For places that parse free-text model output into data (dream.mts task mining).
 *   · `repairLeashToolCall` — `experimental_repairToolCall` for `streamText`: fixes
 *     hallucinated tool names (case/`functions.` prefix) and malformed argument JSON.
 *     Returning `null` keeps the original error; the SDK then degrades the call to a
 *     model-visible invalid call — the stream never crashes either way.
 *
 * NOT `server-only`: `scripts/dream.mts` (a tsx script, not a Next route) imports
 * `safeParseJson` too.
 */
import { jsonrepair } from "jsonrepair";
import { NoSuchToolError, type ToolCallRepairFunction, type ToolSet } from "ai";

/** Strict parse → `jsonrepair` fallback → `undefined`. Never throws. */
export function safeParseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    /* fall through to repair */
  }
  try {
    const repaired = jsonrepair(text);
    const value = JSON.parse(repaired) as T;
    console.warn(`leash: repaired malformed JSON (${text.length} chars)`);
    return value;
  } catch {
    return undefined;
  }
}

/** `name` lowercased with the hallucinated `functions.`/`tools.` prefix stripped. */
function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/^(functions|tools)\./, "");
}

/**
 * Repair hook for `streamText({ experimental_repairToolCall })`. Fires only on
 * `NoSuchToolError` | `InvalidToolInputError`; `toolCall.input` is the RAW JSON string.
 */
export const repairLeashToolCall: ToolCallRepairFunction<ToolSet> = async ({ toolCall, tools, error }) => {
  if (NoSuchToolError.isInstance(error)) {
    // Hallucinated name — try case-insensitive / prefix-stripped match against the registry.
    const want = normalizeToolName(toolCall.toolName);
    const match = Object.keys(tools).find((name) => normalizeToolName(name) === want);
    if (!match) return null; // genuinely unknown → keep the original error
    console.warn(`leash: repaired tool name "${toolCall.toolName}" → "${match}"`);
    return { ...toolCall, toolName: match };
  }

  // InvalidToolInputError — malformed argument JSON. Empty input → `{}` (zero-arg calls);
  // otherwise run jsonrepair and only resend if it actually changed something.
  const raw = toolCall.input ?? "";
  if (raw.trim() === "") {
    console.warn(`leash: repaired empty input for tool "${toolCall.toolName}" → {}`);
    return { ...toolCall, input: "{}" };
  }
  try {
    const repaired = jsonrepair(raw);
    if (repaired === raw) return null; // unchanged → repair can't help
    console.warn(`leash: repaired tool input for "${toolCall.toolName}" (${raw.length} chars)`);
    return { ...toolCall, input: repaired };
  } catch {
    return null; // unfixable → keep the original error (degrades model-visibly)
  }
};
