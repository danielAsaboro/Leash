/**
 * Drive one on-device agent turn and yield growing `UIMessage` snapshots.
 *
 * This is the bridge between the agent loop and the existing `App.tsx` chat state: rather than
 * migrate the whole (voice + history + mesh) screen to `useChat`, the local chat path consumes this
 * generator and copies each snapshot's `parts` onto its `ChatMessage`. `readUIMessageStream`
 * assembles the transport's `UIMessageChunk`s into a coherent `UIMessage` (reasoning + text + tool
 * parts, in order) on every tick — exactly what `useChat` would hold internally.
 */
import { readUIMessageStream, type ModelMessage, type UIMessage } from "ai";
import { buildLeashAgent, type LeashTurn } from "./agent";

export async function* runLeashTurn(
  turn: LeashTurn,
  messages: { role: "user" | "assistant"; content: string }[],
  signal?: AbortSignal,
): AsyncGenerator<UIMessage> {
  const agent = buildLeashAgent(turn);
  const result = await agent.stream({ messages: messages as ModelMessage[], abortSignal: signal });
  for await (const ui of readUIMessageStream({ stream: result.toUIMessageStream() })) {
    yield ui;
  }
}

/** Concatenate the text parts of a UIMessage — the plain-text answer for history/voice/TTS. */
export function textFromParts(message: UIMessage): string {
  return message.parts
    .filter((p): p is Extract<UIMessage["parts"][number], { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
}
