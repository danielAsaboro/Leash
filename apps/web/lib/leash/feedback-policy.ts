export interface ReasoningFeedback {
  mode?: "direct" | "draft" | "deep";
  totalTokens?: number;
  draftTokens?: number;
  draftMs?: number;
  responseMs?: number;
}

const nonNegativeFinite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Keep feedback telemetry bounded to known scalar fields; hidden reasoning is never accepted. */
export function normalizeReasoningFeedback(value: unknown): ReasoningFeedback | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const mode = input["mode"] === "direct" || input["mode"] === "draft" || input["mode"] === "deep" ? input["mode"] : undefined;
  const totalTokens = nonNegativeFinite(input["totalTokens"]);
  const draftTokens = nonNegativeFinite(input["draftTokens"]);
  const draftMs = nonNegativeFinite(input["draftMs"]);
  const responseMs = nonNegativeFinite(input["responseMs"]);
  if (!mode && totalTokens === undefined && draftTokens === undefined && draftMs === undefined && responseMs === undefined) return undefined;
  return { ...(mode ? { mode } : {}), ...(totalTokens !== undefined ? { totalTokens } : {}), ...(draftTokens !== undefined ? { draftTokens } : {}), ...(draftMs !== undefined ? { draftMs } : {}), ...(responseMs !== undefined ? { responseMs } : {}) };
}
