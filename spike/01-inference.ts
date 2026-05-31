/**
 * Spike (a) — on-device text generation + embeddings, with a device-fit pass.
 *
 * GO criteria: tokens stream, an embedding vector with a sane dimension is
 * returned, and tok/s is logged. Device-fit: load phone/Pi-class (0.6B), 1B, and
 * Mac-class (4B) and record tok/s + process RSS for each, so SPIKE_RESULTS.md can
 * say which sizes run where.
 *
 *   npm run spike:inference
 */
import {
  loadModel,
  unloadModel,
  completion,
  embed,
  LLAMA_3_2_1B_INST_Q4_0,
  QWEN3_600M_INST_Q4,
  QWEN3_4B_INST_Q4_K_M,
  GTE_LARGE_FP16,
} from "@qvac/sdk";
import { AuditLog, now } from "./lib/audit-log.ts";

const audit = new AuditLog("01-inference");
const rssMB = () => Math.round(process.memoryUsage().rss / 1024 / 1024);

interface Measured {
  ttftMs: number;
  tokensPerSecond: number;
  generatedTokens: number;
  device?: "cpu" | "gpu";
}

/** Stream one prompt and measure TTFT + tok/s (prefer SDK stats, fall back to wall clock). */
async function runCompletion(modelId: string, prompt: string, echo: boolean): Promise<Measured> {
  const t0 = now();
  const r = completion({ modelId, history: [{ role: "user", content: prompt }], stream: true });
  let firstAt = 0;
  let count = 0;
  for await (const token of r.tokenStream) {
    if (count === 0) firstAt = now();
    count++;
    if (echo) process.stdout.write(token);
  }
  if (echo) process.stdout.write("\n");
  const endAt = now();
  const stats = await r.stats;
  const ttftMs = stats?.timeToFirstToken ?? (firstAt ? firstAt - t0 : 0);
  const wallTokPerSec = count / Math.max((endAt - (firstAt || t0)) / 1000, 1e-6);
  const tokensPerSecond = stats?.tokensPerSecond ?? wallTokPerSec;
  const generatedTokens = stats?.generatedTokens ?? count;
  return { ttftMs, tokensPerSecond, generatedTokens, device: stats?.backendDevice };
}

async function deviceFit(label: string, modelSrc: string, prompt: string, echo = false) {
  const before = rssMB();
  const tLoad = now();
  const modelId = await loadModel({ modelSrc, modelType: "llm", onProgress: () => {} });
  const loadMs = now() - tLoad;
  const afterLoad = rssMB();
  audit.record({ event: "model_load", modelSrc, modelId, durationMs: loadMs, extra: { label, rssBeforeMB: before, rssAfterLoadMB: afterLoad } });

  const m = await runCompletion(modelId, prompt, echo);
  audit.record({
    event: "completion",
    modelSrc,
    modelId,
    device: m.device,
    prompt,
    tokens: m.generatedTokens,
    ttftMs: Math.round(m.ttftMs),
    tokensPerSecond: m.tokensPerSecond,
    extra: { label, rssDeltaMB: afterLoad - before },
  });
  console.log(`   → ${label}: TTFT ${Math.round(m.ttftMs)}ms · ${m.tokensPerSecond.toFixed(1)} tok/s · device=${m.device ?? "?"} · ~RAM Δ ${afterLoad - before}MB`);

  await unloadModel({ modelId });
  audit.record({ event: "model_unload", modelSrc, modelId });
}

try {
  console.log("=== (a) On-device text generation ===\n");
  console.log("Streaming from LLAMA_3_2_1B_INST_Q4_0:\n");
  {
    const modelId = await loadModel({ modelSrc: LLAMA_3_2_1B_INST_Q4_0, modelType: "llm", onProgress: () => {} });
    audit.record({ event: "model_load", modelSrc: LLAMA_3_2_1B_INST_Q4_0, modelId });
    const m = await runCompletion(modelId, "Explain what an exocortex is, in one sentence.", true);
    audit.record({ event: "completion", modelSrc: LLAMA_3_2_1B_INST_Q4_0, modelId, device: m.device, tokens: m.generatedTokens, ttftMs: Math.round(m.ttftMs), tokensPerSecond: m.tokensPerSecond });
    console.log(`\nTTFT ${Math.round(m.ttftMs)}ms · ${m.tokensPerSecond.toFixed(1)} tok/s · device=${m.device ?? "?"}`);
    await unloadModel({ modelId });
    audit.record({ event: "model_unload", modelSrc: LLAMA_3_2_1B_INST_Q4_0, modelId });
  }

  console.log("\n=== (a) On-device embeddings ===\n");
  {
    const embId = await loadModel({ modelSrc: GTE_LARGE_FP16, modelType: "embeddings", onProgress: () => {} });
    audit.record({ event: "model_load", modelSrc: GTE_LARGE_FP16, modelId: embId });
    const { embedding } = await embed({ modelId: embId, text: "Mycelium is a private device-mesh exocortex." });
    console.log(`Embedding dimension: ${embedding.length}`);
    console.log(`First 5 dims: [${embedding.slice(0, 5).map((x) => x.toFixed(4)).join(", ")}, ...]`);
    audit.record({ event: "embedding", modelSrc: GTE_LARGE_FP16, modelId: embId, tokens: 1, extra: { dim: embedding.length } });
    await unloadModel({ modelId: embId });
    audit.record({ event: "model_unload", modelSrc: GTE_LARGE_FP16, modelId: embId });
  }

  console.log("\n=== Device-fit pass (model sizes by device class) ===");
  const fitPrompt = "List three benefits of running AI locally. Be brief.";
  const fits: Array<[string, string]> = [
    ["phone/Pi-class · QWEN3_600M_INST_Q4", QWEN3_600M_INST_Q4],
    ["1B · LLAMA_3_2_1B_INST_Q4_0", LLAMA_3_2_1B_INST_Q4_0],
    ["Mac-class · QWEN3_4B_INST_Q4_K_M", QWEN3_4B_INST_Q4_K_M],
  ];
  for (const [label, src] of fits) {
    // A size that won't load on this device is itself a device-fit datum — not fatal.
    try {
      await deviceFit(label, src, fitPrompt);
    } catch (e) {
      console.log(`   → ${label}: DID NOT LOAD/RUN — ${String(e)}`);
      audit.record({ event: "note", modelSrc: src, extra: { label, deviceFit: "failed", error: String(e) } });
    }
  }

  console.log(`\n✅ GO if you saw streamed tokens, an embedding dim, and tok/s above. Log: ${audit.path}`);
} catch (error) {
  console.error("❌ inference spike failed:", error);
  audit.record({ event: "note", extra: { error: String(error) } });
  process.exit(1);
}
