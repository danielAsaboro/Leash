/**
 * In-flight generation counter (server-only) — the dashboard's no-abort guard.
 *
 * The qvac serve WEDGES its decode loop machine-wide if a request is aborted
 * mid-generation (verified 2026-06-05; see the chat route's no-`abortSignal` note).
 * Stopping/restarting the serve while a generation is in flight is the same wound
 * by another knife — so serve stop/restart MUST be refused while this counter > 0.
 *
 * The counter lives on `globalThis` so Next dev HMR module reloads don't fork it.
 * It is per-web-process state: after a `next dev` restart it resets to 0 while the
 * serve may still be decoding an abandoned turn — the serve-control UI keeps a
 * confirm dialog as the human backstop for that blind spot.
 */
import "server-only";

const slot = (globalThis as Record<string, unknown>) as { __leashInflight?: { count: number } };
const state = (slot.__leashInflight ??= { count: 0 });

/** Mark a generation started. Returns a release fn that is safe to call more than once. */
export function beginGeneration(): () => void {
  state.count++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.count = Math.max(0, state.count - 1);
  };
}

/** How many generations this web process believes are in flight against the serve. */
export function inflightCount(): number {
  return state.count;
}
