import type { LeashUIMessage } from "./types.ts";

/** Visible text of a UI message for token estimation and compaction.
 * Reasoning / `<think>` parts stay in the stored UI transcript, but never return
 * to future agent calls through the compaction summary. */
export function compactableMessageText(m: LeashUIMessage): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parts = (m.parts as any[]) ?? [];
  const text = parts
    .filter((p) => p?.type === "text")
    .map((p) => p.text ?? "")
    .join(" ");
  return text.replace(/\s+/g, " ").trim();
}
