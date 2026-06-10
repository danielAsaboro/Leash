/**
 * Metered (pay-as-you-go) session mechanism — PURE policy, no I/O, no chain (mirrors the
 * spend-policy.ts discipline, so it is exhaustively testable by scripts/smoke-metered.ts).
 *
 * The economic shape (independent of HOW the consumer chunks its decode):
 *   - The consumer escalates an authorization LADDER: tier-0 at open, then a fresh Permit2 witness
 *     for a higher CUMULATIVE token cap before each new chunk (`advance_authorization`).
 *   - The provider appends each verified rung and resets an idle watchdog.
 *   - At CLOSE the provider settles ONE rung (the highest reached) at amountForTokens(min(reported,
 *     acceptedThrough)) — never charging more tokens than the consumer authorized.
 *   - On ABANDONMENT (no advance within advanceWindowMs) the watchdog settles the full authorized
 *     cap (the consumer signed for it → it is owed), then the session is removed.
 *
 * This module owns ONLY that arithmetic + state transitions. The provider (provider-economy.ts)
 * supplies verified rungs and the on-chain settle; the consumer (shim.ts) drives the decode loop.
 */
import type { AuthorizationRung, MeteredState } from "./economy-types.ts";

export interface MeteredConfig {
  /** Tokens decoded per chunk before the consumer must advance. */
  chunkTokens: number;
  /** Idle window before the watchdog force-settles the authorized cap. */
  advanceWindowMs: number;
}

/** Fresh metered state at session open (tier-0 is appended once its verified budget is recorded). */
export function initMeteredState(cfg: MeteredConfig, openedAt: string): MeteredState {
  return {
    chunkTokens: cfg.chunkTokens,
    advanceWindowMs: cfg.advanceWindowMs,
    ladder: [],
    acceptedThroughTokens: 0,
    lastAdvanceAt: openedAt,
  };
}

/** The current (highest) rung, or undefined before tier-0 is recorded. */
export function topRung(state: MeteredState): AuthorizationRung | undefined {
  return state.ladder[state.ladder.length - 1];
}

/**
 * Append a verified rung. Idempotent on tierIndex: a replayed advance returns the state unchanged
 * (`applied: false`) iff it matches the recorded rung, else it is a conflict. Enforces strictly
 * increasing tierIndex AND cumulativeTokens so the ladder can only ever escalate.
 */
export function appendRung(state: MeteredState, rung: AuthorizationRung): { state: MeteredState; applied: boolean } {
  if (!Number.isInteger(rung.tierIndex) || rung.tierIndex < 0) throw new Error(`invalid rung tierIndex ${rung.tierIndex}`);
  if (!(rung.cumulativeTokens > 0)) throw new Error(`invalid rung cumulativeTokens ${rung.cumulativeTokens}`);
  const existing = state.ladder.find((r) => r.tierIndex === rung.tierIndex);
  if (existing) {
    if (existing.authorizationDigest !== rung.authorizationDigest || existing.cumulativeTokens !== rung.cumulativeTokens) {
      throw new Error(`advance tier ${rung.tierIndex} conflicts with the recorded rung`);
    }
    return { state, applied: false };
  }
  const top = topRung(state);
  if (top && rung.tierIndex <= top.tierIndex) throw new Error(`advance tier ${rung.tierIndex} is not above current tier ${top.tierIndex}`);
  if (top && rung.cumulativeTokens <= top.cumulativeTokens) throw new Error(`advance tier ${rung.tierIndex} does not raise the token cap`);
  const ladder = [...state.ladder, rung];
  return {
    state: { ...state, ladder, acceptedThroughTokens: rung.cumulativeTokens, lastAdvanceAt: rung.acceptedAt },
    applied: true,
  };
}

/** Close-time charge: never charge more tokens than the consumer authorized (`min`). */
export function settleTokensAtClose(state: MeteredState, reportedTokens: number): number {
  const reported = Math.max(0, Math.floor(reportedTokens));
  return Math.min(reported, state.acceptedThroughTokens);
}

/** Abandonment charge: the consumer signed for the cap → the full authorized amount is owed. */
export function settleTokensAtCutoff(state: MeteredState): number {
  return state.acceptedThroughTokens;
}

/**
 * The rung to settle on-chain: the highest reached. Its verified budget caps at cumulativeAmount,
 * which covers any settleTokens ≤ acceptedThroughTokens, so a single settle suffices.
 */
export function rungToSettle(state: MeteredState): AuthorizationRung | undefined {
  return topRung(state);
}

/** Watchdog: has the idle window elapsed since the last advance? (No rungs yet → never idle-cut.) */
export function isIdleExpired(state: MeteredState, nowMs: number): boolean {
  return state.ladder.length > 0 && nowMs - Date.parse(state.lastAdvanceAt) > state.advanceWindowMs;
}

/** Consumer-side: must the next chunk be authorized first? (i.e. would it exceed the current cap). */
export function needsAdvanceBeforeChunk(state: MeteredState, producedTokens: number): boolean {
  return producedTokens + state.chunkTokens > state.acceptedThroughTokens;
}

/** Consumer-side: the cumulative token cap to authorize for tier N (tiers are 1×, 2×, … chunkTokens). */
export function cumulativeTokensForTier(cfg: MeteredConfig, tierIndex: number): number {
  return (tierIndex + 1) * cfg.chunkTokens;
}
