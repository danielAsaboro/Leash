/**
 * Promote a trained adapter onto the live web chat — Layer 4 → Layer 5.
 *
 * The web chat hits `qvac serve` via the alias in `LEASH_CHAT_MODEL` (default
 * "chat"). To make the main surface "better at you", we add a sibling alias
 * `chat-me` that mirrors `chat`'s config plus `lora: <adapter>`. The base
 * alias stays for the growth-chart A/B.
 *
 * MACHINE-NEUTRALITY: `qvac.config.base.json` is SYNCED across Macs, but each Mac
 * trains its own adapter under the per-machine (rsync-excluded) `data/`. So we copy
 * the promoted adapter to a STABLE, machine-local path `~/.qvac/adapters/<alias>.gguf`
 * and write the alias's `config.lora` as the literal `~/...` form — qvac.config.mjs
 * expands `~/` to each machine's home at load. Same config string everywhere; each
 * machine resolves it to its own adapter (or, if it hasn't trained, the alias simply
 * isn't loaded — it's preload:false/default:false, only used when opted into).
 *
 * Adapter swaps need a serve RELOAD to take effect — use the dashboard Force-restart /
 * broker supervision; never kill a mid-generation worker (house GPU-wedge taboo).
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AuditLog } from "@mycelium/shared";
import { CONFIG_BASE } from "./paths.ts";

/** Which served base alias a trained base maps to (only the chat model is served). */
export function servedAliasForBase(baseModelName: string): { baseAlias: string; aliasName: string } | undefined {
  if (baseModelName === "QWEN3_4B_INST_Q4_K_M") return { baseAlias: "chat", aliasName: "chat-me" };
  return undefined; // 600M etc. apply via the edge/council loadModel({lora}) path, not the serve
}

interface ServeAlias {
  model?: string;
  src?: string;
  type?: string;
  preload?: boolean;
  default?: boolean;
  config?: Record<string, unknown>;
}
interface ServeConfig {
  serve?: { models?: Record<string, ServeAlias> };
  [k: string]: unknown;
}

export interface PromoteResult {
  aliasName: string;
  /** The `~/`-form path written into config.lora (machine-neutral). */
  loraConfigValue: string;
  /** The absolute path the adapter was copied to on THIS machine. */
  copiedTo: string;
  configPath: string;
}

export interface PromoteParams {
  ggufPath: string;
  baseModelName: string;
  configPath?: string;
  audit?: AuditLog;
}

/**
 * Copy the adapter to the stable per-machine path and upsert the `chat-me` alias
 * into the serve config. Returns undefined if the base model isn't the served chat
 * model (e.g. a 600M fallback adapter, applied elsewhere).
 */
export function promoteAdapterToServe(params: PromoteParams): PromoteResult | undefined {
  const mapping = servedAliasForBase(params.baseModelName);
  if (!mapping) return undefined;
  const { baseAlias, aliasName } = mapping;
  const configPath = params.configPath ?? CONFIG_BASE;

  // 1. copy the adapter to the stable, machine-local path the config will reference.
  const adaptersDir = join(homedir(), ".qvac", "adapters");
  mkdirSync(adaptersDir, { recursive: true });
  const copiedTo = join(adaptersDir, `${aliasName}.gguf`);
  copyFileSync(params.ggufPath, copiedTo);
  const loraConfigValue = `~/.qvac/adapters/${aliasName}.gguf`;

  // 2. upsert the alias: mirror the base alias's model + config, add lora.
  const config = JSON.parse(readFileSync(configPath, "utf-8")) as ServeConfig;
  config.serve = config.serve ?? {};
  config.serve.models = config.serve.models ?? {};
  const base = config.serve.models[baseAlias];
  const mergedConfig: Record<string, unknown> = { ...(base?.config ?? { tools: true, toolsMode: "dynamic", ctx_size: 16384 }), lora: loraConfigValue };
  const alias: ServeAlias = {
    ...(base?.model ? { model: base.model } : { model: params.baseModelName }),
    preload: false, // don't load two 4B models at startup; load chat-me on demand
    default: false, // base chat stays the default (growth-chart A/B)
    config: mergedConfig,
  };
  config.serve.models[aliasName] = alias;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  params.audit?.record({ event: "note", extra: { role: "serve-alias", aliasName, baseAlias, loraConfigValue, copiedTo } });
  return { aliasName, loraConfigValue, copiedTo, configPath };
}
