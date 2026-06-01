/**
 * Delegated-inference consumer (Layer 1 — Mesh).
 *
 * Wraps `loadModel({ delegate })` (proven in spike/03-p2p-consumer.ts). The weak
 * device registers a model against a provider's public key and gets back a
 * `modelId`; any `completion({ modelId })` then runs ON THE PROVIDER and streams
 * tokens back over the encrypted link. `fallbackToLocal` degrades to local
 * inference if the link is unavailable.
 *
 * `modelConfig.tools: true` + a roomy `ctx_size` are set so the delegated model is
 * tool-call-capable — the council's proposer runs through this delegated id.
 */
import { loadModel } from "@qvac/sdk";
import { now } from "@mycelium/shared";
import type { AuditLog } from "@mycelium/shared";
import type { ModelSrc } from "@mycelium/senses";

export interface LoadDelegatedParams {
  modelSrc: ModelSrc;
  providerPublicKey: string;
  /** Cold DHT bootstrap can take 15–45s on first call; default generous. */
  timeout?: number;
  /** Degrade to local inference if the provider is unreachable. */
  fallbackToLocal?: boolean;
  /** Context window for the delegated model. */
  ctxSize?: number;
  audit?: AuditLog;
}

/** Register a model on the provider; returns a modelId whose completions run there. */
export async function loadDelegated({
  modelSrc,
  providerPublicKey,
  timeout = 60_000,
  fallbackToLocal = true,
  ctxSize = 4096,
  audit,
}: LoadDelegatedParams): Promise<string> {
  const t = now();
  const modelId = await loadModel({
    modelSrc,
    modelType: "llm",
    modelConfig: { ctx_size: ctxSize, tools: true },
    delegate: { providerPublicKey, timeout, fallbackToLocal },
    onProgress: () => {},
  });
  audit?.record({
    event: "delegation",
    modelId,
    durationMs: now() - t,
    extra: { role: "consumer", phase: "connect+register", providerPublicKey },
  });
  return modelId;
}
