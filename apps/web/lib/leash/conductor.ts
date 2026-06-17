// apps/web/lib/leash/conductor.ts
/**
 * Conductor — capability-first router. A fast-path gate short-circuits obviously-trivial
 * turns to the cheapest local general model; everything else is graded by the warm 1.7B
 * classifier into a capability bar, and rankRoutes picks the route. Never throws: any
 * failure falls back to a deterministic bar from classifyEffort + intent regex, then local.
 */
import "server-only";
import { generateText } from "ai";
import { classifyEffort } from "./effort.ts";
import { classifierModel } from "./provider.ts";
import {
  rankRoutes,
  type CapabilityBar, type Modality, type RouteOption, type Sensitivity,
} from "@mycelium/leash-core/routing";

// Re-export pure helpers + RouteDecision so existing import sites of conductor.ts keep working.
export { barFromFallback, pickLocalGeneral } from "./conductor-utils.ts";
export type { RouteDecision } from "./conductor-utils.ts";
// Internal use — imported separately so the type is available inside this module.
import type { RouteDecision } from "./conductor-utils.ts";
import { barFromFallback, pickLocalGeneral } from "./conductor-utils.ts";

const RUBRIC =
  "You are a request router. Classify the user's turn for placement. Reply with ONLY compact JSON " +
  '{"modality":"text|vision|audio","difficulty":"low|medium|high","sensitivity":"private|shareable","specialist":"general|health|vision|computer"}. ' +
  "sensitivity=private for anything personal/health/financial/confidential; shareable only for generic public-knowledge questions. " +
  "difficulty=high for multi-step reasoning, analysis, planning, or coding; low for greetings/lookups. Output JSON only.";

interface Grade { modality: Modality; difficulty: "low" | "medium" | "high"; sensitivity: Sensitivity; specialist: CapabilityBar["specialist"] }

function parseGrade(raw: string): Grade | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as Partial<Grade>;
    if (!o.modality || !o.difficulty || !o.sensitivity) return null;
    return { modality: o.modality, difficulty: o.difficulty, sensitivity: o.sensitivity, specialist: o.specialist ?? "general" };
  } catch { return null; }
}

function barFromGrade(g: Grade): CapabilityBar {
  const minParamClass = g.difficulty === "high" ? "mid" : "small";
  return { modality: g.modality, minParamClass, ...(g.specialist && g.specialist !== "general" ? { specialist: g.specialist } : {}) };
}

function decide(bar: CapabilityBar, sensitivity: Sensitivity, options: RouteOption[], defaultAlias: string, viaFastPath: boolean): RouteDecision {
  const ranked = rankRoutes({ bar, sensitivity, options });
  const top = ranked[0];
  if (top) {
    return { modality: bar.modality, sensitivity, bar, route: { tier: top.tier, alias: top.alias, ...(top.peerKey ? { peerKey: top.peerKey } : {}), ...(top.meshId ? { meshId: top.meshId } : {}), ...(top.modelSrc ? { modelSrc: top.modelSrc } : {}) }, reason: top.reason, viaFastPath };
  }
  const local = pickLocalGeneral(options, defaultAlias);
  return { modality: bar.modality, sensitivity, bar, route: { tier: "device", alias: local.alias }, reason: "no route cleared the bar → local fallback", viaFastPath };
}

export async function conduct(input: { text: string; isImageTurn: boolean; options: RouteOption[]; defaultAlias: string }): Promise<RouteDecision> {
  const tier = await classifyEffort(input.text);
  // Fast-path: obviously-trivial text turn → cheapest local general, no LLM.
  if (tier === "quick" && !input.isImageTurn) {
    const local = pickLocalGeneral(input.options, input.defaultAlias);
    return { modality: "text", sensitivity: "private", bar: { modality: "text", minParamClass: "small" }, route: { tier: "device", alias: local.alias }, reason: "fast-path: trivial turn → local", viaFastPath: true };
  }
  try {
    const { text } = await generateText({ model: classifierModel(), system: RUBRIC, prompt: input.text.slice(0, 2000), temperature: 0, maxOutputTokens: 80, maxRetries: 0 });
    const grade = parseGrade(text);
    if (grade) return decide(barFromGrade(grade), grade.sensitivity, input.options, input.defaultAlias, false);
  } catch { /* fall through to deterministic fallback */ }
  // Deterministic fallback (serve down / unparseable): effort+intent bar, sensitivity defaults private.
  return decide(barFromFallback({ tier, isImageTurn: input.isImageTurn, text: input.text }), "private", input.options, input.defaultAlias, false);
}
