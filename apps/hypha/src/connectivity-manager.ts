/**
 * Consumer-side connectivity self-heal (Approach C, de-scoped — see
 * docs/superpowers/specs/2026-06-10-resilient-reconnection-design.md).
 *
 * A clean provider restart already self-heals via the SDK's own per-RPC reconnect
 * (`ensureRPCConnection` in `@qvac/sdk` server/bare/delegate-rpc-client.js — proven live
 * 2026-06-10). What that does NOT cover is the whole transport going stale at once: the device
 * SLEPT (a wall-clock gap) or ROAMED networks (every provider unreachable in the same tick). For
 * those, the only reliable recovery is to tear down + rebuild the SDK's swarm/corestore
 * (`suspend()` + `resume()`) and force a warm-pool re-warm.
 *
 * This module is two parts:
 *   - `decideHeal` — a PURE reducer that decides whether the current tick is a real disruption
 *     (wake-gap or all-providers-unreachable cluster) vs. a single-provider blip the SDK already
 *     handles. Unit-tested by `scripts/smoke-reconnect.ts` (no network).
 *   - `ConnectivityManager` — the effectful loop: probe each live provider (SDK `heartbeat`), run
 *     the reducer, and on a heal decision call `resetTransport()` (suspend+resume) + `rewarm()`.
 *     Dependency-injected so it never imports the SDK or the warm pool directly.
 *
 * Gated by `HYPHA_RESILIENT_RECONNECT` (default off → not started → byte-identical proven core).
 */

export type ReconnectReason = "wake-gap" | "all-providers-unreachable";

export interface ReconnectConfig {
  /** A wall-clock gap between ticks larger than this ⇒ the device slept → heal. */
  wakeGapMs: number;
  /** Minimum time between heals (anti-thrash). */
  healCooldownMs: number;
  /** Consecutive all-providers-unreachable ticks before declaring a roam → heal. */
  allFailThreshold: number;
}

export interface ReconnectState {
  /** Wall-clock of the previous tick, or null before the first tick. */
  lastTickAt: number | null;
  /** Consecutive ticks where every probed provider was unreachable. */
  consecutiveAllFail: number;
  /** Wall-clock of the last heal, for the cooldown; null if never healed. */
  lastHealAt: number | null;
}

export interface ReconnectTick {
  now: number;
  providersProbed: number;
  providersFailed: number;
}

export interface ReconnectDecision {
  state: ReconnectState;
  heal: boolean;
  reason: ReconnectReason | null;
}

export function initialReconnectState(): ReconnectState {
  return { lastTickAt: null, consecutiveAllFail: 0, lastHealAt: null };
}

/**
 * PURE. Given the prior state, this tick's probe result, and the config, decide whether to heal
 * and return the next state. Heals on a wake-gap (device slept) or a sustained all-unreachable
 * cluster (network roam), never on the first tick's gap, never on a single-provider blip, never
 * inside the cooldown.
 */
export function decideHeal(state: ReconnectState, tick: ReconnectTick, cfg: ReconnectConfig): ReconnectDecision {
  const isFirstTick = state.lastTickAt === null;
  const gap = isFirstTick ? 0 : tick.now - (state.lastTickAt as number);
  const wokeFromSleep = !isFirstTick && gap > cfg.wakeGapMs;

  // "All unreachable" only means something when we actually probed someone (0/0 ≠ network down).
  const allFail = tick.providersProbed > 0 && tick.providersFailed >= tick.providersProbed;
  const consecutiveAllFail = allFail ? state.consecutiveAllFail + 1 : 0;
  const roamDetected = consecutiveAllFail >= cfg.allFailThreshold;

  const cooldownOk = state.lastHealAt === null || tick.now - state.lastHealAt >= cfg.healCooldownMs;
  const reason: ReconnectReason | null = wokeFromSleep ? "wake-gap" : roamDetected ? "all-providers-unreachable" : null;
  const heal = reason !== null && cooldownOk;

  return {
    state: {
      lastTickAt: tick.now,
      consecutiveAllFail: heal ? 0 : consecutiveAllFail,
      lastHealAt: heal ? tick.now : state.lastHealAt,
    },
    heal,
    reason: heal ? reason : null,
  };
}

export interface ConnectivityDeps {
  /** Probe one provider for liveness (SDK `heartbeat`); resolve true iff alive. Never throws. */
  probe: (providerPublicKey: string) => Promise<boolean>;
  /** The provider public keys to probe this tick (from the warm pool's live set). */
  liveProviders: () => string[];
  /** Tear down + rebuild the SDK transport (`suspend()` then `resume()`). */
  resetTransport: () => Promise<void>;
  /** Drop + re-warm the consumer's delegated models after a transport reset. */
  rewarm: () => Promise<void>;
  now: () => number;
  // Matches the daemon's AuditLog.record (we only ever emit `note` rows); typed to the literal so
  // the real AuditLog is assignable under strictFunctionTypes.
  audit?: { record: (e: { event: "note"; extra?: Record<string, unknown> }) => void };
}

export interface ConnectivityConfig extends ReconnectConfig {
  enabled: boolean;
  intervalMs: number;
}

/**
 * The effectful loop around `decideHeal`. Probes live providers each `intervalMs`, and on a heal
 * decision resets the SDK transport + re-warms — single-flight so overlapping ticks can't stack
 * two resets. Inert until `start()` and only if `enabled`.
 */
export class ConnectivityManager {
  private state: ReconnectState = initialReconnectState();
  private timer: ReturnType<typeof setInterval> | null = null;
  private healing: Promise<void> | null = null;

  constructor(private readonly deps: ConnectivityDeps, private readonly cfg: ConnectivityConfig) {}

  start(): void {
    if (!this.cfg.enabled || this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.cfg.intervalMs);
    this.deps.audit?.record({ event: "note", extra: { role: "connectivity", phase: "started", intervalMs: this.cfg.intervalMs } });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One probe → decide → maybe heal cycle. Exposed for deterministic tests/manual triggers. */
  async tick(): Promise<void> {
    const providers = this.deps.liveProviders();
    let failed = 0;
    for (const p of providers) {
      if (!(await this.deps.probe(p))) failed++;
    }
    const { state, heal, reason } = decideHeal(
      this.state,
      { now: this.deps.now(), providersProbed: providers.length, providersFailed: failed },
      this.cfg,
    );
    this.state = state;
    if (heal && reason) await this.heal(reason);
  }

  /** suspend()+resume() the transport then re-warm. Single-flight (concurrent calls share one run). */
  private heal(reason: ReconnectReason): Promise<void> {
    if (this.healing) return this.healing;
    this.healing = (async () => {
      const t0 = this.deps.now();
      this.deps.audit?.record({ event: "note", extra: { role: "connectivity", phase: "heal-start", reason } });
      try {
        await this.deps.resetTransport();
        await this.deps.rewarm();
        this.deps.audit?.record({ event: "note", extra: { role: "connectivity", phase: "heal-done", reason, ms: this.deps.now() - t0 } });
      } catch (err) {
        this.deps.audit?.record({ event: "note", extra: { role: "connectivity", phase: "heal-failed", reason, error: String(err) } });
      } finally {
        this.healing = null;
      }
    })();
    return this.healing;
  }
}
