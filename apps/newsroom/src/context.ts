/**
 * The newsroom's loaded-model context + telemetry helpers.
 *
 * One context is shared across a pipeline pass: the embedding model (RAG grounding)
 * and the council LLM (draft + review) are loaded once and reused; the diffusion
 * model is loaded lazily on first hero image and then reused. Every pipeline step
 * also writes a `DaemonRun` row (Mission Control's telemetry feed) and an `AuditLog`
 * record — so a single seed run already produces a full, inspectable trail.
 */
import { completion, loadModel, unloadModel } from "@qvac/sdk";
import { AuditLog } from "@mycelium/shared";
import { loadEmbeddings, unloadEmbeddings, QWEN3_4B_INST_Q4_K_M } from "@mycelium/senses";
import { prisma, type RunKind } from "@mycelium/db";
import { LOG_DIR } from "./config.ts";

export interface Newsroom {
  audit: AuditLog;
  /** GTE embeddings — RAG ingest + search. */
  embId: string;
  /** QWEN3_4B council model — drafting + review. */
  llmId: string;
  /** Diffusion model id, loaded lazily by the image step. */
  diffId?: string;
}

/** Boot the always-needed models (embeddings + council LLM). */
export async function openNewsroom(): Promise<Newsroom> {
  const audit = new AuditLog("newsroom", LOG_DIR);
  const embId = await loadEmbeddings(audit);
  const llmId = await loadModel({
    modelSrc: QWEN3_4B_INST_Q4_K_M,
    modelType: "llm",
    modelConfig: { ctx_size: 4096 },
    onProgress: () => {},
  });
  audit.record({ event: "model_load", modelSrc: "QWEN3_4B_INST_Q4_K_M", modelId: llmId, extra: { role: "council" } });
  return { audit, embId, llmId };
}

/** Unload every model the newsroom holds. */
export async function closeNewsroom(nr: Newsroom): Promise<void> {
  await unloadEmbeddings(nr.embId, nr.audit);
  await unloadModel({ modelId: nr.llmId });
  nr.audit.record({ event: "model_unload", modelId: nr.llmId, extra: { role: "council" } });
  if (nr.diffId) {
    await unloadModel({ modelId: nr.diffId, clearStorage: false } as Parameters<typeof unloadModel>[0]);
    nr.audit.record({ event: "model_unload", modelId: nr.diffId, extra: { role: "diffusion" } });
  }
}

/**
 * One grounded completion (drain the stream so `final` resolves). Returns the text.
 * Used by draft + review; the council tool-loop lives in @mycelium/mind for queries,
 * but drafting retrieves sources up front and passes them inline, so plain completion
 * is the right primitive here.
 */
export async function complete(
  nr: Newsroom,
  system: string,
  user: string,
  predict: number,
  role: string,
): Promise<string> {
  const run = completion({
    modelId: nr.llmId,
    history: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    stream: true,
    generationParams: { predict, reasoning_budget: 0 },
  });
  let out = "";
  for await (const t of run.tokenStream) out += t;
  const final = await run.final;
  nr.audit.record({
    event: "completion",
    modelId: nr.llmId,
    tokens: final.stats?.generatedTokens,
    extra: { role },
  });
  return (final.contentText || out).trim();
}

/** Run a pipeline step, bracketing it with a DaemonRun row (start → finish/ok). */
export async function recordRun<T>(
  kind: RunKind,
  articleId: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const run = await prisma.daemonRun.create({ data: { kind, articleId: articleId ?? null } });
  try {
    const result = await fn();
    await prisma.daemonRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), ok: true },
    });
    return result;
  } catch (err) {
    await prisma.daemonRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), ok: false, detail: String(err).slice(0, 500) },
    });
    throw err;
  }
}

/** Best-effort extraction of the first JSON value (object or array) from model text. */
export function extractJson<T>(text: string): T | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? (fenced[1] ?? "") : text;
  const start = candidate.search(/[[{]/);
  if (start < 0) return undefined;
  // Walk to the matching close bracket so trailing prose doesn't break the parse.
  const open = candidate[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = start; i < candidate.length; i++) {
    const c = candidate[i];
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1)) as T;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}
