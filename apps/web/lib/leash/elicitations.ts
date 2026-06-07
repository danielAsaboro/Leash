/**
 * MCP elicitation broker (server-only, in-memory) — the bridge between an MCP server's
 * `elicitInput` request (which arrives on the long-lived MCP client connection) and the
 * human sitting in the chat UI.
 *
 * Flow: an MCP tool call needs user input → the server sends `elicitation/create` → our
 * client handler calls `requestElicitation` (a pending Promise registered here) → the
 * chat route's stream wrapper pushes a transient `data-elicitation` part to the browser
 * → the user fills the form → `POST /api/leash/elicitations/[id]` calls
 * `respondElicitation` → the Promise resolves → the MCP tool continues.
 *
 * Registered on `globalThis` so Next's dev-mode module reloads don't orphan pendings.
 * Every pending elicitation TIMES OUT to `{action:"cancel"}` (default 120 s) — the chat
 * can never hang on a form nobody answers.
 */
import "server-only";
import { randomUUID } from "node:crypto";

export interface ElicitResultLike {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

export interface PendingElicitation {
  id: string;
  serverName: string;
  message: string;
  /** The flat elicitation JSON schema the client renders a form from. */
  requestedSchema: unknown;
  createdAt: number;
  expiresAt: number;
}

export type ElicitationEvent =
  | { kind: "open"; elicitation: PendingElicitation }
  | { kind: "resolved"; id: string; action: ElicitResultLike["action"] };

interface Entry {
  pending: PendingElicitation;
  resolve: (r: ElicitResultLike) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Broker {
  entries: Map<string, Entry>;
  listeners: Set<(ev: ElicitationEvent) => void>;
}

const g = globalThis as unknown as { __leashElicitations?: Broker };
const broker: Broker = (g.__leashElicitations ??= { entries: new Map(), listeners: new Set() });

const DEFAULT_TIMEOUT_MS = Number(process.env["LEASH_ELICIT_TIMEOUT_MS"] ?? 120_000);

function emit(ev: ElicitationEvent): void {
  for (const l of [...broker.listeners]) {
    try {
      l(ev);
    } catch {
      /* a dead stream listener must not break the broker */
    }
  }
}

/** Register a pending elicitation; resolves on user response or times out to cancel. */
export function requestElicitation(input: { serverName: string; message: string; requestedSchema: unknown; timeoutMs?: number }): Promise<ElicitResultLike> {
  const id = randomUUID();
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pending: PendingElicitation = {
    id,
    serverName: input.serverName,
    message: input.message,
    requestedSchema: input.requestedSchema,
    createdAt: Date.now(),
    expiresAt: Date.now() + timeoutMs,
  };
  return new Promise<ElicitResultLike>((resolve) => {
    const timer = setTimeout(() => {
      broker.entries.delete(id);
      emit({ kind: "resolved", id, action: "cancel" });
      resolve({ action: "cancel" }); // timeout — the chat never hangs
    }, timeoutMs);
    timer.unref?.();
    broker.entries.set(id, { pending, resolve, timer });
    emit({ kind: "open", elicitation: pending });
  });
}

/** Resolve a pending elicitation with the user's answer. False if unknown/already done. */
export function respondElicitation(id: string, result: ElicitResultLike): boolean {
  const entry = broker.entries.get(id);
  if (!entry) return false;
  clearTimeout(entry.timer);
  broker.entries.delete(id);
  emit({ kind: "resolved", id, action: result.action });
  entry.resolve(result);
  return true;
}

/** Cancel every pending elicitation from one server (e.g. its client got closed). */
export function cancelElicitationsFor(serverName: string): void {
  for (const [id, entry] of [...broker.entries]) {
    if (entry.pending.serverName !== serverName) continue;
    clearTimeout(entry.timer);
    broker.entries.delete(id);
    emit({ kind: "resolved", id, action: "cancel" });
    entry.resolve({ action: "cancel" });
  }
}

/** Subscribe to open/resolved events (chat streams). Returns the unsubscribe. */
export function subscribeElicitations(listener: (ev: ElicitationEvent) => void): () => void {
  broker.listeners.add(listener);
  return () => broker.listeners.delete(listener);
}

/** Snapshot of currently-pending elicitations (reload recovery). */
export function listPendingElicitations(): PendingElicitation[] {
  return [...broker.entries.values()].map((e) => e.pending).sort((a, b) => a.createdAt - b.createdAt);
}
