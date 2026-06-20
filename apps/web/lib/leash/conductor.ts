import "server-only";
import { generateText } from "ai";
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
    const { text } = await generateText({
      model: conductorModel(conductorAlias),
      system,
      prompt,
      temperature: 0,
      topP: 1,
      maxOutputTokens: 320,
      maxRetries: 0,
    });
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
