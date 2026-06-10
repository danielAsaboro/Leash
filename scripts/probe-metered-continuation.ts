/**
 * PHASE 2 PROBE — can a single assistant turn be generated in CHUNKS via `predict` + `kvCache`?
 *
 * Metered settlement pre-pays per chunk, so the consumer decode loop must:
 *   (1) cap each chunk at ~N tokens with `generationParams.predict: N` (NOT hang — there's a
 *       documented qwen3vl-after-image-decode hang with max_tokens; text chat is the question), and
 *   (2) RESUME the SAME assistant turn for the next chunk so the concatenation is coherent (NOT
 *       restart). The `kvCache` "assistant turn contract" (cacheableAssistantContent) is a TURN
 *       boundary contract; mid-turn resume is unverified — this probe finds out empirically.
 *
 * This loads a model and generates — run it ONLY when you mean to (it spins the GPU):
 *
 *   PROBE_RUN=1 npm run probe:metered-continuation
 *   PROBE_RUN=1 PROBE_MODEL=<registry-name-or-src> PROBE_CHUNK_TOKENS=32 npm run probe:metered-continuation
 *
 * Output is for HUMAN judgement: compare the one-shot reference to the chunked concatenation, and
 * check that each chunk stopped near `predict` (not far over → predict ignored; not 0 → hang).
 */
import { completion, loadModel, unloadModel, deleteCache, LLAMA_3_2_1B_INST_Q4_0 } from "@qvac/sdk";

if (!process.env["PROBE_RUN"]) {
  console.error("This probe loads a model and generates (GPU). Re-run with PROBE_RUN=1 to proceed:");
  console.error("  PROBE_RUN=1 npm run probe:metered-continuation");
  process.exit(0);
}

const MODEL = process.env["PROBE_MODEL"] || LLAMA_3_2_1B_INST_Q4_0;
const CHUNK = Number(process.env["PROBE_CHUNK_TOKENS"] ?? 32);
const MAX_CHUNKS = Number(process.env["PROBE_MAX_CHUNKS"] ?? 6);
const KV_KEY = "probe-metered-continuation";
const PROMPT = process.env["PROBE_PROMPT"] || "Write a single coherent paragraph (~120 words) explaining how photosynthesis works.";

interface ChatTurn { role: string; content: string }

let modelId = "";

async function runOnce(history: ChatTurn[], predict?: number): Promise<{ text: string; tokens: number; ms: number }> {
  const t0 = Date.now();
  const run = completion({
    modelId,
    history,
    stream: true,
    kvCache: KV_KEY,
    ...(predict ? { generationParams: { predict } } : {}),
  });
  let text = "";
  let tokens = 0;
  for await (const tok of run.tokenStream) {
    text += tok;
    tokens++;
  }
  await run.final.catch(() => undefined);
  return { text, tokens, ms: Date.now() - t0 };
}

try {
  console.log(`\nPHASE 2 PROBE — metered chunked continuation\n  model=${MODEL}  chunkTokens=${CHUNK}  maxChunks=${MAX_CHUNKS}\n`);
  modelId = await loadModel({ modelSrc: MODEL as never, modelType: "llm", onProgress: () => {} });

  // ── Reference: one-shot, no predict cap ───────────────────────────────────────────────────────
  await deleteCache({ kvCacheKey: KV_KEY }).catch(() => undefined);
  console.log("① one-shot reference (no predict)…");
  const ref = await runOnce([{ role: "user", content: PROMPT }]);
  console.log(`   tokens=${ref.tokens}  ms=${ref.ms}`);
  console.log(`   text: ${ref.text.replace(/\n/g, " ")}\n`);

  // ── Chunked: predict-capped chunks, accumulating the assistant turn back into history ──────────
  await deleteCache({ kvCacheKey: KV_KEY }).catch(() => undefined);
  console.log(`② chunked (predict=${CHUNK} per chunk, accumulate assistant content into history)…`);
  let assistant = "";
  const perChunk: number[] = [];
  for (let i = 0; i < MAX_CHUNKS; i++) {
    const history: ChatTurn[] = [{ role: "user", content: PROMPT }];
    if (assistant) history.push({ role: "assistant", content: assistant });
    const c = await runOnce(history, CHUNK);
    perChunk.push(c.tokens);
    assistant += c.text;
    const capped = c.tokens <= CHUNK + 4; // ~predict (small slack for stop tokens)
    console.log(`   chunk ${i}: tokens=${c.tokens} ${capped ? "(≈capped)" : "(⚠ predict NOT respected)"} ms=${c.ms} | +"${c.text.replace(/\n/g, " ").slice(0, 64)}"`);
    if (c.tokens === 0) { console.log("   ⚠ zero tokens — possible predict/kvCache hang; aborting chunk loop"); break; }
    if (c.tokens < CHUNK) { console.log("   (model stopped short of predict → natural end of turn)"); break; }
  }

  console.log(`\n   chunk token counts: [${perChunk.join(", ")}]  total=${perChunk.reduce((a, b) => a + b, 0)}`);
  console.log(`   concatenated: ${assistant.replace(/\n/g, " ")}\n`);
  console.log("VERDICT (human): is the concatenation a COHERENT single paragraph (continuation), or does");
  console.log("each chunk restart/repeat (mid-turn resume NOT supported)? And did each chunk stop near");
  console.log(`predict=${CHUNK}? If yes+yes → the metered consumer loop is viable as designed. If chunks`);
  console.log("restart, the loop needs a different mid-turn resume mechanism before it can be built.");
} catch (error) {
  console.error("\n❌ probe errored:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await deleteCache({ kvCacheKey: KV_KEY }).catch(() => undefined);
  if (modelId) await unloadModel({ modelId }).catch(() => undefined);
}
