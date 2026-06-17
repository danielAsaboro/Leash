// apps/web/lib/leash/conductor-utils.ts
/**
 * Pure, dependency-free conductor helpers — no server-only, no AI SDK, no provider/effort
 * imports. Extracted so tsx test scripts can import them without triggering the Next.js
 * server-only guard or the @qvac/ai-sdk-provider ESM-only restriction.
 */
import type { EffortTier } from "./types.ts";
import {
  tagsForAlias,
  type CapabilityBar, type Modality, type RouteOption, type Sensitivity, type Tier,
} from "@mycelium/leash-core/routing";

export interface RouteDecision {
  modality: Modality;
  sensitivity: Sensitivity;
  bar: CapabilityBar;
  route: { tier: Tier; alias: string; peerKey?: string; meshId?: string; modelSrc?: string };
  reason: string;
  viaFastPath: boolean;
}

const HEALTH = /\b(symptom|diagnos|therapy|anxiety|depress|medication|dosage|blood pressure|clinical|patient)\b/i;

/** Deterministic bar from effort tier + intent regex (the no-LLM fallback). */
export function barFromFallback(i: { tier: EffortTier; isImageTurn: boolean; text: string }): CapabilityBar {
  if (i.isImageTurn) return { modality: "vision", minParamClass: "small", specialist: "vision" };
  if (HEALTH.test(i.text)) return { modality: "text", minParamClass: "small", specialist: "health" };
  const minParamClass = i.tier === "deep" ? "mid" : "small";
  return { modality: "text", minParamClass };
}

/** Cheapest local general text route; synthesizes one for `defaultAlias` if none discovered. */
export function pickLocalGeneral(options: RouteOption[], defaultAlias: string): RouteOption {
  const locals = options.filter((o) => o.tier === "device" && o.tags.modality === "text" && o.tags.specialist === "general").sort((a, b) => a.inflight - b.inflight);
  return locals[0] ?? { tier: "device", alias: defaultAlias, tags: tagsForAlias(defaultAlias), pricePerKiloToken: 0, inflight: 0 };
}
