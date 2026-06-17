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

export interface LeashSkillRef {
  slug: string;
  name: string;
}

/** Persisted `data-skill` part: route/model loaded skills for this assistant turn. */
export interface LeashSkillEvent {
  mode: "explicit" | "automatic";
  skills: LeashSkillRef[];
}

/** One atomic step of a plan-mode plan, with its live execution status. */
export type PlanStepStatus = "pending" | "active" | "done" | "failed" | "skipped";
export interface PlanStep {
  id: string;
  text: string;
  status: PlanStepStatus;
  /** A short result digest (done) or error (failed). */
  note?: string;
}
/**
 * Persisted `data-plan` part: the plan-mode plan for an assistant turn. Proposed plans render
 * from the `submit_plan` tool input (approval gate); once approved, the route streams this part
 * (same `id`, reconciled in place) as the deterministic pipeline executes each step.
 */
export interface PlanData {
  id: string;
  title?: string;
  status: "proposed" | "running" | "done" | "failed" | "rejected";
  steps: PlanStep[];
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

/** Persisted `data-conductor` part: the Conductor's route decision for an assistant turn. */
export interface ConductorDecisionEvent {
  /** "local <alias>" or "→ peer <alias> (<tier>)". */
  tier: string;
  alias: string;
  peerKey?: string;
  meshId?: string;
  reason: string;
  viaFastPath: boolean;
}

/** Typed data parts on the Leash stream. `elicitation` is transient; `skill` + `conductor` + `plan` are persisted. */
export type LeashDataParts = {
  elicitation: LeashElicitationEvent;
  skill: LeashSkillEvent;
  plan: PlanData;
  conductor: ConductorDecisionEvent;
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
