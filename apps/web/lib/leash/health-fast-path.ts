import type { ToolSet } from "ai";

export interface DirectHealthSafetyCall {
  kind: "blood_pressure_meds_clinician";
}

const BP_MEDS_CLINICIAN_RE =
  /\bhealth-safety\b[\s\S]{0,160}\b(?:clinician|doctor|provider)\b[\s\S]{0,160}\b(?:blood pressure|bp)\b[\s\S]{0,160}\bmeds?\b|\b(?:blood pressure|bp)\b[\s\S]{0,120}\bmeds?\b[\s\S]{0,120}\b(?:clinician|doctor|provider)\b/i;

export function directHealthSafetyCallForSimpleTurn(text: string): DirectHealthSafetyCall | null {
  const q = (text ?? "").trim();
  if (!q || q.length > 800) return null;
  return BP_MEDS_CLINICIAN_RE.test(q) ? { kind: "blood_pressure_meds_clinician" } : null;
}

function outputText(value: unknown): string {
  if (!value || typeof value !== "object") return String(value ?? "");
  const rec = value as Record<string, unknown>;
  if (typeof rec.text === "string") return rec.text;
  if (Array.isArray(rec.content)) {
    const text = rec.content
      .map((part) => (part && typeof part === "object" && (part as Record<string, unknown>)["type"] === "text" ? (part as Record<string, unknown>)["text"] : ""))
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join("\n");
    if (text) return text;
  }
  return JSON.stringify(value);
}

function hasUsefulContext(text: string): boolean {
  return text.trim().length > 0 && !/^No (?:saved memories|matching passages)/i.test(text.trim());
}

export async function runDirectHealthSafetyCall(call: DirectHealthSafetyCall, registry: ToolSet): Promise<string | null> {
  if (call.kind !== "blood_pressure_meds_clinician") return null;
  const recall = registry["recall"] as { execute?: (args: unknown, opts?: unknown) => Promise<unknown> } | undefined;
  const search = registry["search_graph"] as { execute?: (args: unknown, opts?: unknown) => Promise<unknown> } | undefined;
  if (typeof recall?.execute !== "function" && typeof search?.execute !== "function") return null;

  const context: string[] = [];
  if (typeof recall?.execute === "function") {
    const text = outputText(await recall.execute({ query: "blood pressure medication meds prescription" }, {}));
    if (hasUsefulContext(text)) context.push(`Memory: ${text.slice(0, 500)}`);
  }
  if (typeof search?.execute === "function") {
    const text = outputText(await search.execute({ query: "blood pressure meds medications clinician", topK: 3 }, {}));
    if (hasUsefulContext(text)) context.push(`Context: ${text.slice(0, 700)}`);
  }

  const contextLine = context.length
    ? `Private context checked: ${context.join(" ")}`
    : "I did not find matching private context from the available health read tools.";
  return [
    contextLine,
    "Non-diagnostic clinician questions: ask whether your current medication, dose, and timing still fit your home BP readings; what side effects or interactions to watch for; what readings should trigger urgent contact; and whether labs or follow-up monitoring are due.",
  ].join("\n\n");
}
