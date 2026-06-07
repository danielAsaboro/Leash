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

/** A pending MCP elicitation (server→user form), surfaced as a transient data part. */
export interface ElicitationView {
  id: string;
  serverName: string;
  message: string;
  /** The flat elicitation JSON schema the client renders a form from. */
  requestedSchema: unknown;
  createdAt: number;
  expiresAt: number;
}

/** Transient `data-elicitation` events the chat stream pushes (open / resolved). */
export type LeashElicitationEvent = { kind: "open"; elicitation: ElicitationView } | { kind: "resolved"; id: string; action: "accept" | "decline" | "cancel" };

/** Typed data parts on the Leash stream (all transient — never persisted in messages). */
export type LeashDataParts = {
  elicitation: LeashElicitationEvent;
};

/** The Leash UI message, carrying `LeashMetadata` + typed data parts. */
export type LeashUIMessage = UIMessage<LeashMetadata, LeashDataParts>;

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
