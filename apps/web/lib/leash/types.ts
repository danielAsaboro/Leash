/** Client-safe Leash chat types (no server-only imports — shared by route + UI). */
import type { UIMessage } from "ai";

/**
 * Dynamic-effort tier a turn was graded into (server-side embedding classifier).
 * Client-safe so VoiceCall/LeashChat can reference it without pulling server-only code.
 */
export type EffortTier = "quick" | "standard" | "deep";

/** Per-message telemetry, emitted by the route via `messageMetadata`. */
export interface LeashMetadata {
  /** ms epoch when generation started (the `start` stream part). */
  createdAt?: number;
  /** ms epoch when generation finished (the `finish` stream part). */
  finishedAt?: number;
  /** The served model alias that produced the message. */
  model?: string;
  /** Total tokens for the turn (from the finish part's usage). */
  totalTokens?: number;
  /** The dynamic-effort tier this turn was classified into. */
  effort?: EffortTier;
}

/** The Leash UI message, carrying `LeashMetadata`. */
export type LeashUIMessage = UIMessage<LeashMetadata>;

/** Summary for the chat history tray + the dreaming pass. */
export interface ChatSummary {
  id: string;
  createdAt: number;
  updatedAt: number;
  title: string;
  messageCount: number;
}

/** One consolidated "thing to work on" from the future dreaming service. */
export interface ConsolidationItem {
  id: string;
  title: string;
  detail?: string;
  /** Source chats this was distilled from. */
  chatIds?: string[];
  createdAt?: number;
}
