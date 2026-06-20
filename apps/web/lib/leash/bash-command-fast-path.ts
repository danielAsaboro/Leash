import type { ToolSet } from "ai";

const DATE_COMMAND_RE =
  /\b(?:run|execute)\b[\s\S]{0,30}\bdate\b|\b(?:use|call|invoke)\b[\s\S]{0,40}\b(?:bash|shell)\b[\s\S]{0,40}\bdate\b|\bdate\s+(?:command|output)\b/i;

export function directBashCommandForSimpleTurn(text: string): string | null {
  const q = (text ?? "").trim();
  if (!q || q.length > 320) return null;
  return DATE_COMMAND_RE.test(q) ? "date" : null;
}

function outputText(value: unknown): string {
  if (!value || typeof value !== "object") return String(value ?? "");
  const rec = value as Record<string, unknown>;
  if (typeof rec.text === "string") return rec.text;
  return JSON.stringify(value);
}

export async function runDirectBashCommand(command: string, registry: ToolSet): Promise<string | null> {
  const bash = registry["bash"] as { execute?: (args: unknown, opts?: unknown) => Promise<unknown> } | undefined;
  if (typeof bash?.execute !== "function") return null;
  const result = await bash.execute({ command }, {});
  return outputText(result).trim();
}
