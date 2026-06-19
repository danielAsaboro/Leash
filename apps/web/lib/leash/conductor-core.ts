import { rankRoutes, tagsForAlias, type CapabilityBar, type Modality, type RouteOption, type Sensitivity, type Tier } from "@mycelium/leash-core/routing";
import type { EffortTier } from "./types.ts";

export interface RouterCatalogModel {
  name: string;
  endpointCategory?: string;
  params?: string;
}

export interface RouterServeModelEntry {
  model?: string;
  src?: string;
  type?: string;
  preload?: boolean;
  default?: boolean;
  config?: Record<string, unknown>;
}

export interface RouterQvacConfig {
  serve?: { models?: Record<string, RouterServeModelEntry | string> };
}

export interface RouterLiveModels {
  up: boolean;
  ready: string[];
}

export interface ConfiguredModelSpec {
  alias: string;
  sdkModelName: string | null;
  endpointCategory: string | null;
  params: string | null;
  ctxSize: number | null;
  toolsMode: string | null;
  tools: boolean | null;
  isDefault: boolean;
  preload: boolean;
  loaded: boolean | null;
  ready: boolean | null;
}

export interface ConductorRoute {
  alias: string;
  reason: string;
  needsTools: boolean;
  needsVision: boolean;
  needsMemory: boolean;
  needsFiles: boolean;
  sensitivity: Sensitivity;
}

export type ConductorTurnDecision =
  | { action: "answer"; answer: string }
  | { action: "route"; route: ConductorRoute };

export type ParsedConductorDecision =
  | { ok: true; decision: ConductorTurnDecision }
  | { ok: false; reason: string; raw?: string };

export interface ConductorTurnMetadata {
  messageCount: number;
  userTurnCount: number;
  voice: boolean;
  selectedModel: string | null;
  planMode: boolean;
}

export interface DeterministicRouteNeed {
  required: boolean;
  reason: string;
  needsTools: boolean;
  needsVision: boolean;
  needsMemory: boolean;
  needsFiles: boolean;
}

function availableInventory(inventory: ConfiguredModelSpec[]): ConfiguredModelSpec[] {
  return inventory.filter((m) => m.ready !== false && m.loaded !== false);
}

function conductorInventoryRows(inventory: ConfiguredModelSpec[]) {
  return availableInventory(inventory).map((m) => ({
    alias: m.alias,
    sdkModelName: m.sdkModelName,
    endpointCategory: m.endpointCategory,
    params: m.params,
    ctxSize: m.ctxSize,
    toolsMode: m.toolsMode,
    tools: m.tools,
    default: m.isDefault,
    preload: m.preload,
    ready: m.ready,
  }));
}

function normalizeServeEntry(raw: RouterServeModelEntry | string): RouterServeModelEntry {
  return typeof raw === "string" ? { model: raw } : raw;
}

function ctxSize(entry: RouterServeModelEntry): number | null {
  const raw = entry.config?.["ctx_size"];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function toolsMode(entry: RouterServeModelEntry): string | null {
  const raw = entry.config?.["toolsMode"];
  return typeof raw === "string" && raw ? raw : null;
}

function toolsEnabled(entry: RouterServeModelEntry): boolean | null {
  const raw = entry.config?.["tools"];
  return typeof raw === "boolean" ? raw : null;
}

function effectiveEndpointCategory(entry: RouterServeModelEntry, catalog?: RouterCatalogModel): string | null {
  if (typeof entry.config?.["projectionModelSrc"] === "string") return "vision";
  if (entry.type?.includes("embedding")) return "embedding";
  if (entry.type?.includes("completion")) return "chat";
  if (entry.type?.includes("transcription")) return "speech";
  return catalog?.endpointCategory ?? null;
}

function liveOnlyEndpointCategory(alias: string): string | null {
  const tags = tagsForAlias(alias);
  if (tags.modality === "vision") return "vision";
  if (tags.modality === "audio") return "audio";
  if (tags.modality === "text") return "chat";
  return null;
}

export function buildConfiguredModelInventory(input: {
  config: RouterQvacConfig;
  catalog: RouterCatalogModel[];
  live: RouterLiveModels;
}): ConfiguredModelSpec[] {
  const byName = new Map(input.catalog.map((m) => [m.name, m]));
  const ready = new Set(input.live.ready);
  const out = Object.entries(input.config.serve?.models ?? {}).map(([alias, raw]) => {
    const entry = normalizeServeEntry(raw);
    const catalog = entry.model ? byName.get(entry.model) : undefined;
    const isReady = input.live.up ? ready.has(alias) : null;
    return {
      alias,
      sdkModelName: entry.model ?? null,
      endpointCategory: effectiveEndpointCategory(entry, catalog),
      params: catalog?.params ?? null,
      ctxSize: ctxSize(entry),
      toolsMode: toolsMode(entry),
      tools: toolsEnabled(entry),
      isDefault: entry.default === true,
      preload: entry.preload !== false,
      loaded: isReady,
      ready: isReady,
    };
  });
  const configured = new Set(out.map((m) => m.alias));
  if (input.live.up) {
    for (const alias of input.live.ready) {
      if (configured.has(alias)) continue;
      out.push({
        alias,
        sdkModelName: null,
        endpointCategory: liveOnlyEndpointCategory(alias),
        params: null,
        ctxSize: null,
        toolsMode: null,
        tools: null,
        isDefault: false,
        preload: true,
        loaded: true,
        ready: true,
      });
    }
  }
  return out;
}

export function buildConductorPrompt(input: {
  userPrompt: string;
  metadata: ConductorTurnMetadata;
  inventory: ConfiguredModelSpec[];
}): string {
  return JSON.stringify({
    userPrompt: input.userPrompt.slice(0, 2400),
    turn: input.metadata,
  });
}

export function buildConductorInventorySystemSection(inventory: ConfiguredModelSpec[]): string {
  return "Available model inventory JSON for this turn:\n" + JSON.stringify(conductorInventoryRows(inventory));
}

function extractJsonObjects(raw: string): string[] {
  const out: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (start === -1) {
      if (ch === "{") {
        start = i;
        depth = 1;
      }
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = inString;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (depth === 0) {
      out.push(raw.slice(start, i + 1));
      start = -1;
    }
  }
  return out;
}

function isSensitivity(value: unknown): value is Sensitivity {
  return value === "private" || value === "shareable";
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function inventoryAlias(inventory: ConfiguredModelSpec[], alias: unknown): ConfiguredModelSpec | null {
  if (typeof alias !== "string" || !alias.trim()) return null;
  return inventory.find((m) => m.alias === alias) ?? null;
}

function aliasUnavailable(row: ConfiguredModelSpec): boolean {
  return row.ready === false || row.loaded === false;
}

const FILES_MEMORY_RE =
  /\b(?:search|find|look(?:ing)?|list|show|read|cat|open|scan|summari[sz]e|grep|locate)\b[\s\S]{0,50}\b(?:my\s+)?(?:notes?|files?|docs?|documents?|folders?|director(?:y|ies)|repos?|code(?:base)?|workspace|journal|memory|memories)\b|\b(?:my|the|this)\s+(?:notes?|files?|docs?|documents?|folders?|director(?:y|ies)|repos?|code(?:base)?|workspace|journal|memory|memories)\b/i;
const ACTION_RE = /\b(?:write|edit|create|delete|save|download|install|run|execute|open|click|browse|research|look up|check|send|schedule|remind|remember|recall)\b/i;
const CURRENT_RE = /\b(?:latest|current|today|yesterday|tomorrow|now|news|weather|price|stock|score|schedule|exchange rate|verify|fact.?check)\b/i;
const CODE_RE = /\b(?:debug|fix|implement|refactor|test|compile|typescript|javascript|python|repo|codebase|stack trace|error log)\b/i;

export function deterministicRouteNeed(text: string): DeterministicRouteNeed {
  const q = (text ?? "").trim();
  const filesMemory = FILES_MEMORY_RE.test(q);
  const action = ACTION_RE.test(q);
  const current = CURRENT_RE.test(q);
  const code = CODE_RE.test(q);
  const required = filesMemory || action || current || code;
  const needsFiles = /\b(?:files?|docs?|documents?|folders?|director(?:y|ies)|repos?|code(?:base)?|workspace)\b/i.test(q);
  const needsMemory = filesMemory || /\b(?:notes?|memory|memories|remember|recall|journal|preference|my)\b/i.test(q);
  return {
    required,
    reason: filesMemory
      ? "deterministic guard: notes/files/memory request needs the full agent"
      : action
        ? "deterministic guard: action/tool request needs the full agent"
        : current
          ? "deterministic guard: current-data request needs verification"
          : code
            ? "deterministic guard: code/debug request needs the full agent"
            : "direct answer allowed",
    needsTools: required,
    needsVision: false,
    needsMemory,
    needsFiles,
  };
}

function availableForRoute(row: ConfiguredModelSpec, conductorAlias: string): boolean {
  if (row.alias === conductorAlias) return false;
  if (aliasUnavailable(row)) return false;
  if (row.endpointCategory && ["embedding", "speech", "audio", "transcription"].includes(row.endpointCategory)) return false;
  return true;
}

function routeScore(row: ConfiguredModelSpec, need: DeterministicRouteNeed): number {
  const tags = tagsForAlias(row.alias);
  let score = 0;
  if (row.isDefault) score += 1000;
  if (row.tools === true) score += 200;
  if (row.toolsMode) score += 100;
  if (row.endpointCategory === "chat") score += 80;
  if (need.needsVision && (row.endpointCategory === "vision" || tags.modality === "vision")) score += 500;
  if (!need.needsVision && tags.modality === "text") score += 50;
  if (tags.specialist === "general") score += 20;
  return score;
}

export function pickInventoryRouteAlias(input: {
  inventory: ConfiguredModelSpec[];
  conductorAlias: string;
  selectedModel: string | null;
  need: DeterministicRouteNeed;
}): string | null {
  const selected = input.selectedModel ? input.inventory.find((m) => m.alias === input.selectedModel && !aliasUnavailable(m)) : null;
  if (selected) return selected.alias;
  const candidates = input.inventory.filter((m) => availableForRoute(m, input.conductorAlias));
  candidates.sort((a, b) => routeScore(b, input.need) - routeScore(a, input.need));
  return candidates[0]?.alias ?? null;
}

function validateConductorTurnDecision(parsed: unknown, inventory: ConfiguredModelSpec[], raw: string): ParsedConductorDecision {
  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "conductor JSON was not an object", raw };
  const obj = parsed as Record<string, unknown>;
  if (obj.action === "answer") {
    const answer = typeof obj.answer === "string" ? obj.answer.trim() : "";
    if (!answer) return { ok: false, reason: "conductor answer was empty", raw };
    return { ok: true, decision: { action: "answer", answer } };
  }
  if (obj.action !== "route") return { ok: false, reason: "conductor action was invalid", raw };
  if (!obj.route || typeof obj.route !== "object") return { ok: false, reason: "conductor route was missing", raw };
  const route = obj.route as Record<string, unknown>;
  const row = inventoryAlias(inventory, route.alias);
  if (!row) return { ok: false, reason: `conductor selected unknown alias: ${String(route.alias)}`, raw };
  if (aliasUnavailable(row)) return { ok: false, reason: `conductor selected unavailable alias: ${row.alias}`, raw };
  const needsTools = bool(route.needsTools);
  const needsVision = bool(route.needsVision);
  const needsMemory = bool(route.needsMemory);
  const needsFiles = bool(route.needsFiles);
  if (needsTools === null || needsVision === null || needsMemory === null || needsFiles === null) {
    return { ok: false, reason: "conductor route flags were invalid", raw };
  }
  if (!isSensitivity(route.sensitivity)) return { ok: false, reason: "conductor route sensitivity was invalid", raw };
  const reason = typeof route.reason === "string" && route.reason.trim() ? route.reason.trim().slice(0, 160) : "conductor route";
  return {
    ok: true,
    decision: {
      action: "route",
      route: {
        alias: row.alias,
        reason,
        needsTools,
        needsVision,
        needsMemory,
        needsFiles,
        sensitivity: route.sensitivity,
      },
    },
  };
}

export function parseConductorDecision(raw: string, inventory: ConfiguredModelSpec[]): ParsedConductorDecision {
  const candidates = extractJsonObjects(raw);
  if (!candidates.length) return { ok: false, reason: "conductor did not return JSON", raw };
  let firstInvalid: ParsedConductorDecision | null = null;
  let sawMalformed = false;
  for (const json of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      sawMalformed = true;
      continue;
    }
    const validated = validateConductorTurnDecision(parsed, inventory, raw);
    if (validated.ok) return validated;
    firstInvalid ??= validated;
  }
  return firstInvalid ?? { ok: false, reason: sawMalformed ? "conductor returned malformed JSON" : "conductor JSON was invalid", raw };
}

export function capabilityBarFromConductorRoute(route: ConductorRoute): CapabilityBar {
  const tags = tagsForAlias(route.alias);
  const modality = route.needsVision ? "vision" : tags.modality === "vision" ? "vision" : "text";
  const paramClass = tags.paramClass === "tiny" || tags.paramClass === "unknown" ? "small" : tags.paramClass;
  const specialist = route.needsVision ? "vision" : tags.specialist !== "general" ? tags.specialist : undefined;
  return { modality, minParamClass: paramClass, ...(specialist ? { specialist } : {}) };
}

export function publicMeshRouteBlocked(input: {
  bar: CapabilityBar;
  sensitivity: Sensitivity;
  options: RouteOption[];
}): { alias: string; reason: string } | null {
  if (input.sensitivity !== "private") return null;
  const privateEligible = rankRoutes({ bar: input.bar, sensitivity: "private", options: input.options });
  if (privateEligible.length > 0) return null;
  const publicEligible = rankRoutes({
    bar: input.bar,
    sensitivity: "shareable",
    options: input.options.filter((o) => o.tier === "public"),
  });
  const top = publicEligible[0];
  return top ? { alias: top.alias, reason: top.reason } : null;
}

export interface ConductorRouteDecision {
  modality: Modality;
  sensitivity: Sensitivity;
  bar: CapabilityBar;
  route: { tier: Tier; alias: string; peerKey?: string; meshId?: string; modelSrc?: string };
  reason: string;
  viaFastPath: boolean;
}

const HEALTH_RE = /\b(symptom|diagnos|therapy|anxiety|depress|medication|dosage|blood pressure|clinical|patient)\b/i;

export function barFromGuardedTurn(input: { tier: EffortTier; isImageTurn: boolean; text: string }): CapabilityBar {
  if (input.isImageTurn) return { modality: "vision", minParamClass: "small", specialist: "vision" };
  if (HEALTH_RE.test(input.text)) return { modality: "text", minParamClass: "small", specialist: "health" };
  return { modality: "text", minParamClass: input.tier === "deep" ? "mid" : "small" };
}

export function pickLocalGeneral(options: RouteOption[], defaultAlias: string): RouteOption {
  const locals = options
    .filter((o) => o.tier === "device" && o.tags.modality === "text" && o.tags.specialist === "general")
    .sort((a, b) => a.inflight - b.inflight);
  return locals[0] ?? { tier: "device", alias: defaultAlias, tags: tagsForAlias(defaultAlias), pricePerKiloToken: 0, inflight: 0 };
}

export function rankConductorRoute(input: {
  bar: CapabilityBar;
  sensitivity: Sensitivity;
  options: RouteOption[];
  reason?: string;
  viaFastPath?: boolean;
}): ConductorRouteDecision {
  const ranked = rankRoutes({ bar: input.bar, sensitivity: input.sensitivity, options: input.options });
  const top = ranked[0];
  if (!top) {
    throw new Error(`no route cleared the bar for ${input.bar.modality}/${input.bar.minParamClass}${input.bar.specialist ? `/${input.bar.specialist}` : ""}`);
  }
  return {
    modality: input.bar.modality,
    sensitivity: input.sensitivity,
    bar: input.bar,
    route: {
      tier: top.tier,
      alias: top.alias,
      ...(top.peerKey ? { peerKey: top.peerKey } : {}),
      ...(top.meshId ? { meshId: top.meshId } : {}),
      ...(top.modelSrc ? { modelSrc: top.modelSrc } : {}),
    },
    reason: input.reason ? `${input.reason}; ${top.reason}` : top.reason,
    viaFastPath: input.viaFastPath === true,
  };
}
