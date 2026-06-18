/**
 * The on-device chat transport — what makes `useChat` run the agent loop locally, with no server.
 *
 * `DefaultChatTransport` (the Expo-quickstart path) POSTs UI messages to an HTTP `/api/chat` route.
 * The phone has no route, so this custom `ChatTransport` runs the loop IN-PROCESS: on each
 * `sendMessages`, it builds a per-turn `ToolLoopAgent`, streams it, and hands `useChat` the agent's
 * `toUIMessageStream()` — an `AsyncIterableStream<UIMessageChunk>` (which IS a `ReadableStream`, so
 * it satisfies the transport contract directly). The model inside the agent reaches inference via
 * the qvac-bridge fetch, so everything stays on-device.
 *
 * The turn config (model / system / tools / maxSteps) is resolved lazily via `getTurn()` so the
 * screen can swap the model (on-device ↔ borrowed) and grow the tool set per turn without
 * reconstructing the transport.
 */
import { convertToModelMessages, type ChatTransport, type UIMessage, type UIMessageChunk } from "ai";
import { buildLeashAgent, type LeashTurn } from "./agent";

export class LeashTransport implements ChatTransport<UIMessage> {
  constructor(private readonly getTurn: () => LeashTurn | Promise<LeashTurn>) {}

  async sendMessages(options: {
    trigger: "submit-message" | "regenerate-message";
    chatId: string;
    messageId: string | undefined;
    messages: UIMessage[];
    abortSignal: AbortSignal | undefined;
  }): Promise<ReadableStream<UIMessageChunk>> {
    const turn = await this.getTurn();
    const agent = buildLeashAgent(turn);
    const messages = await convertToModelMessages(options.messages);
    const result = await agent.stream({ messages, abortSignal: options.abortSignal });
    // `toUIMessageStream()` returns an AsyncIterableStream<UIMessageChunk> — a ReadableStream.
    // `sendReasoning` defaults to true, so `<think>`-derived reasoning parts flow to the UI.
    return result.toUIMessageStream() as unknown as ReadableStream<UIMessageChunk>;
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    // In-process streams aren't resumable across reloads — nothing to reconnect to.
    return null;
  }
}
