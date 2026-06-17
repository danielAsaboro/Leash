/**
 * Deterministic routing policy — the auditable heart of the Conductor. The LLM produces a
 * capability bar; THIS picks the route. Order: (1) sensitivity tier gate (privacy before
 * cost — a sensitive turn can never reach the public tier no matter how cheap), (2) capability
 * filter (modality + paramClass headroom + specialist), (3) cost+load+privacy ranking.
 */
import type { CapabilityBar, ParamClass, RankedRoute, RouteOption, Sensitivity } from "./types.ts";

export const PARAM_ORDER: Record<ParamClass, number> = { unknown: -1, tiny: 0, small: 1, mid: 2, large: 3 };

const INFLIGHT_PENALTY = 400; // ≈ one paid request — lets a saturated local lose to a free peer
const TIER_BIAS: Record<RouteOption["tier"], number> = { device: 0, private: 50, public: 150 };

function clearsBar(o: RouteOption, bar: CapabilityBar): boolean {
  if (o.tags.modality !== bar.modality) return false;
  if (PARAM_ORDER[o.tags.paramClass] < PARAM_ORDER[bar.minParamClass]) return false;
  if (bar.specialist && bar.specialist !== "general" && o.tags.specialist !== bar.specialist) return false;
  return true;
}

export function rankRoutes(input: { bar: CapabilityBar; sensitivity: Sensitivity; options: RouteOption[] }): RankedRoute[] {
  const { bar, sensitivity, options } = input;
  // (1) Privacy gate FIRST — non-overridable by cost.
  const gated = options.filter((o) => (sensitivity === "private" ? o.tier !== "public" : true));
  // (2) Capability filter.
  const eligible = gated.filter((o) => clearsBar(o, bar));
  // (3) Rank by cost + load + privacy bias.
  return eligible
    .map((o) => {
      const score = o.pricePerKiloToken + o.inflight * INFLIGHT_PENALTY + TIER_BIAS[o.tier];
      const where = o.peerKey ? `peer ${o.alias}@${o.tier}` : `local ${o.alias}`;
      const reason = `${where} · ${o.pricePerKiloToken}µ/ktok · inflight ${o.inflight} · score ${score}`;
      return { ...o, score, reason };
    })
    .sort((a, b) => a.score - b.score);
}
