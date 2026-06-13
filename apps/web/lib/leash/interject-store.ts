/**
 * Mid-turn interject (server-only) — a per-chat boolean: "the user has a follow-up waiting; end the
 * running turn at its next step boundary." Set by the client (POST /api/leash/chat/interject) when it
 * queues a message while a turn is busy; read by the agent loop's `stopWhen` (after each step) and by
 * the plan pipeline (between steps). When it fires the turn finishes cleanly after the current step,
 * the client's queue then sends the waiting message as a normal, visible turn.
 *
 * Process-local in-memory set — a single-user, single-process on-device app, and the flag only matters
 * for the few seconds a turn is live. The route CLEARS it at the start of every turn so it never leaks
 * into the turn it was meant to start.
 */
import "server-only";

// On globalThis (like elicitations/inflight/mcp): the /interject route and the /chat route are
// bundled separately by Next, so a plain module-level Set would be a DIFFERENT instance in each —
// the flag would be set in one and read as false in the other (it silently never fired). The
// globalThis singleton is shared across route bundles (and survives dev HMR reloads).
const g = globalThis as unknown as { __leashInterject?: Set<string> };
const pending: Set<string> = (g.__leashInterject ??= new Set<string>());

/** Ask the chat's running turn to yield after its next step. */
export function requestInterject(chatId: string): void {
  pending.add(chatId);
}

/** Has an interject been requested for this chat? */
export function interjectRequested(chatId: string): boolean {
  return pending.has(chatId);
}

/** Clear the flag (called at the start of each turn, and once consumed). */
export function clearInterject(chatId: string): void {
  pending.delete(chatId);
}
