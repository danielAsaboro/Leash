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
  /**
   * Load the delegated context tool-capable (default true — the council proposer needs
   * it). Set FALSE for a plain chat/completion path (e.g. the Hypha overflow shim, which
   * does raw `completion()` with no tool execution): a tools-enabled context driven with
   * no tools offered can hang (the TOOLLESS-HANG gotcha), so the shim warms toolless.
   */
  tools?: boolean;
  /** Vision only — the provider's absolute mmproj path. The SDK requires it to load a VLM (the
   * registry id alone won't pull the projection over delegation); the provider loads it locally. */
  projectionModelSrc?: string;
  audit?: AuditLog;
}

/** Register a model on the provider; returns a modelId whose completions run there. */
export async function loadDelegated({
  modelSrc,
  providerPublicKey,
  timeout = 60_000,
  fallbackToLocal = true,
  ctxSize = 4096,
  tools = true,
  projectionModelSrc,
  audit,
}: LoadDelegatedParams): Promise<string> {
  const t = now();
  const modelId = await loadModel({
    modelSrc,
    modelType: "llm",
    modelConfig: { ctx_size: ctxSize, tools, ...(projectionModelSrc ? { projectionModelSrc } : {}) },
    delegate: { providerPublicKey, timeout, fallbackToLocal },
    onProgress: () => {},
  } as Parameters<typeof loadModel>[0]);
  audit?.record({
    event: "delegation",
    modelId,
    durationMs: now() - t,
    extra: { role: "consumer", phase: "connect+register", providerPublicKey },
  });
  return modelId;
}
