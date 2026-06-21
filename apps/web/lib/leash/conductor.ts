import "server-only";
import { streamText } from "ai";
import { classifierModel as conductorModel, resolvedClassifierAlias as resolvedConductorAlias } from "./provider.ts";
import { liveModels, readCatalog, readQvacConfig } from "./models.ts";
import {
  buildConductorInventorySystemSection,
  buildConductorPrompt,
  buildConfiguredModelInventory,
  deterministicRouteNeed,
  invalidConductorFallbackRoute,
  parseConductorDecision,
  pickInventoryRouteAlias,
  type ConductorTurnDecision,
  type ConductorTurnMetadata,
  type ConfiguredModelSpec,
  type ParsedConductorDecision,
} from "./conductor-core.ts";
import { CONDUCTOR_SYSTEM_PROMPT, CONDUCTOR_USER_PROMPT_PREFIX, buildConductorExamplesSystemSection } from "./prompt.ts";

const CONDUCTOR_TIMEOUT = { totalMs: 30_000, stepMs: 20_000, chunkMs: 12_000 } as const;

export type ConductorResult =
  | {
      ok: true;
      decision: ConductorTurnDecision;
      conductorAlias: string;
      inventory: ConfiguredModelSpec[];
      latencyMs: number;
      raw: string;
    }
  | {
      ok: false;
      failureReason: string;
      conductorAlias: string;
      inventory: ConfiguredModelSpec[];
      latencyMs: number;
      raw?: string;
    };

export async function configuredModelInventory(): Promise<ConfiguredModelSpec[]> {
  const [config, catalog, live] = await Promise.all([readQvacConfig(), readCatalog(), liveModels()]);
  return buildConfiguredModelInventory({ config, catalog, live });
}

function conductorAliasFromInventory(inventory: ConfiguredModelSpec[]): string {
  const configured = inventory.find((m) => m.alias === "classifier" && m.ready !== false);
  return configured?.alias ?? resolvedConductorAlias();
}

function resultFromParsed(input: {
  parsed: ParsedConductorDecision;
  conductorAlias: string;
  inventory: ConfiguredModelSpec[];
  latencyMs: number;
  raw: string;
}): ConductorResult {
  if (input.parsed.ok) {
    return {
      ok: true,
      decision: input.parsed.decision,
      conductorAlias: input.conductorAlias,
      inventory: input.inventory,
      latencyMs: input.latencyMs,
      raw: input.raw,
    };
  }
  return {
    ok: false,
    failureReason: input.parsed.reason,
    conductorAlias: input.conductorAlias,
    inventory: input.inventory,
    latencyMs: input.latencyMs,
    raw: input.raw,
  };
}

function enforceDirectAnswerGuard(input: {
  parsed: ParsedConductorDecision;
  userPrompt: string;
  conductorAlias: string;
  inventory: ConfiguredModelSpec[];
  selectedModel: string | null;
  raw: string;
}): ParsedConductorDecision {
  if (!input.parsed.ok || input.parsed.decision.action !== "answer") return input.parsed;
  const need = deterministicRouteNeed(input.userPrompt);
  if (!need.required) return input.parsed;
  const alias = pickInventoryRouteAlias({
    inventory: input.inventory,
    conductorAlias: input.conductorAlias,
    selectedModel: input.selectedModel,
    need,
  });
  if (!alias) return { ok: false, reason: `${need.reason}; no live non-conductor route alias was available`, raw: input.raw };
  return {
    ok: true,
    decision: {
      action: "route",
      route: {
        alias,
        reason: need.reason,
        needsTools: need.needsTools,
        needsVision: need.needsVision,
        needsMemory: need.needsMemory,
        needsFiles: need.needsFiles,
        sensitivity: need.needsMemory || need.needsFiles ? "private" : "shareable",
      },
    },
  };
}

export async function conductTurn(input: {
  userPrompt: string;
  metadata: ConductorTurnMetadata;
}): Promise<ConductorResult> {
  const started = Date.now();
  let inventory: ConfiguredModelSpec[] = [];
  let conductorAlias = resolvedConductorAlias();
  try {
    inventory = await configuredModelInventory();
    conductorAlias = conductorAliasFromInventory(inventory);
    const prompt = CONDUCTOR_USER_PROMPT_PREFIX + buildConductorPrompt({ userPrompt: input.userPrompt, metadata: input.metadata, inventory });
    const system = [CONDUCTOR_SYSTEM_PROMPT, buildConductorInventorySystemSection(inventory), buildConductorExamplesSystemSection(inventory, conductorAlias)].join("\n\n");
    // QVAC 0.13.x can leave non-stream llama.cpp completions pending indefinitely even after the
    // worker has finished prefill. The user-facing agent already uses streaming; keep the conductor
    // on the same transport and await its accumulated text so turn one cannot wedge before routing.
    const result = streamText({
      model: conductorModel(conductorAlias),
      instructions: system,
      prompt,
      temperature: 0,
      topP: 1,
      maxOutputTokens: 320,
      maxRetries: 0,
      timeout: CONDUCTOR_TIMEOUT,
      reasoning: "none",
    });
    const text = await result.text;
    return resultFromParsed({
      parsed: invalidConductorFallbackRoute({
        parsed: enforceDirectAnswerGuard({
          parsed: parseConductorDecision(text, inventory),
          userPrompt: input.userPrompt,
          conductorAlias,
          inventory,
          selectedModel: input.metadata.selectedModel,
          raw: text,
        }),
        userPrompt: input.userPrompt,
        conductorAlias,
        inventory,
        selectedModel: input.metadata.selectedModel,
        raw: text,
      }),
      conductorAlias,
      inventory,
      latencyMs: Date.now() - started,
      raw: text,
    });
  } catch (err) {
    return {
      ok: false,
      failureReason: err instanceof Error ? err.message : String(err),
      conductorAlias,
      inventory,
      latencyMs: Date.now() - started,
    };
  }
}
