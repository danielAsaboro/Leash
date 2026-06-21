export interface AuthoritativeToolEvidence {
  toolName: string;
  status: "output" | "error";
  value: unknown;
}

/** Compact JSON passed between workers and the parent synthesis call. */
export function structuredAuthoritativeToolEvidence(
  evidence: AuthoritativeToolEvidence[],
  maxChars = 2_400,
): string {
  const encoded = JSON.stringify({
    authoritativeToolEvidence: evidence.map((entry) => ({
      tool: entry.toolName,
      status: entry.status,
      value: compact(entry.value),
    })),
  });
  if (encoded.length <= maxChars) return encoded;
  const perEntry = Math.max(120, Math.floor((maxChars - 240) / Math.max(1, evidence.length)));
  return JSON.stringify({
    authoritativeToolEvidence: evidence.map((entry) => ({
      tool: entry.toolName,
      status: entry.status,
      preview: serialize(entry.value).slice(0, perEntry),
      truncated: true,
    })),
  });
}

function compact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length > 700 ? `${value.slice(0, 688)} [truncated]` : value;
  if (value === null || typeof value !== "object") return value;
  if (depth >= 3) return "[nested value omitted]";
  if (Array.isArray(value)) {
    const items = value.slice(0, 4).map((entry) => compact(entry, depth + 1));
    if (value.length > items.length) items.push(`[${value.length - items.length} more items]`);
    return items;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  return Object.fromEntries(
    entries.slice(0, 10).map(([key, entry]) => [key, compact(entry, depth + 1)]),
  );
}

function serialize(value: unknown): string {
  if (typeof value === "string") return String(compact(value));
  try {
    return JSON.stringify(compact(value));
  } catch {
    return String(value);
  }
}

/** Keep actual tool outcomes in the delegate result even when prose synthesis omits one. */
export function appendAuthoritativeToolEvidence(
  summary: string,
  evidence: AuthoritativeToolEvidence[],
  maxChars = 1_600,
): string {
  if (!evidence.length) return summary;
  const ledger = evidence
    .map((entry, index) => `${index + 1}. ${entry.toolName} [${entry.status}]: ${serialize(entry.value)}`)
    .join("\n")
    .slice(0, maxChars);
  return `${summary}\n\nAuthoritative tool evidence:\n${ledger}`.trim();
}
