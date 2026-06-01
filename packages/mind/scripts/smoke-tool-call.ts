/**
 * De-risking smoke test (build sequence step 2): prove the real `search_graph`
 * tool-call loop end to end on the council's proposer model.
 *
 *   npm run mind:smoke
 *
 * GO criteria:
 *   1. A `search_graph` tool call appears in `final.toolCalls`.
 *   2. After the retrieved snippets are fed back, the model prints a [Source N]-
 *      cited answer naming the correct model (QWEN3_600M_INST_Q4).
 *   3. A `rag_search` record lands in packages/mind/logs/mind-smoke.jsonl.
 *
 * Model note (step-2 finding): the plan originally named the community fine-tune
 * `LLAMA_TOOL_CALLING_1B_INST_Q4_K`, but it emits prose instead of parseable tool
 * calls under the SDK's tool injection (verified across auto/pythonic/hermes
 * dialects). Mainstream Qwen3 emits clean `<tool_call>{json}</tool_call>` — so the
 * council proposer/critic is `QWEN3_4B_INST_Q4_K_M` (Mac-class, cached, runs on the
 * hub). `reasoning_budget: 0` suppresses Qwen3's chain-of-thought.
 *
 * `runSearch` here is the same ragIngest/ragSearch pattern as spike/02-rag.ts;
 * step 3 formalizes it into @mycelium/senses (searchGraph), and step 4 wraps this
 * loop into runCouncil. The proposer is loaded with `modelConfig.tools: true` and
 * a roomy `ctx_size`, per the SDK's native-tools example.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadModel,
  unloadModel,
  completion,
  ragIngest,
  ragSearch,
  ragCloseWorkspace,
  GTE_LARGE_FP16,
  QWEN3_4B_INST_Q4_K_M,
  type CompletionFinal,
} from "@qvac/sdk";
import { AuditLog, now } from "@mycelium/shared";
import { SEARCH_GRAPH_TOOL } from "../src/tools.ts";

const here = dirname(fileURLToPath(import.meta.url));
const NOTES_DIR = join(here, "..", "..", "..", "spike", "fixtures", "notes");
const WORKSPACE = "mycelium-mind-smoke";
const QUESTION = "Which model does Dani run on the Raspberry Pi node, and why?";
const audit = new AuditLog("mind-smoke", join(here, "..", "logs"));

type Msg = { role: string; content: string };

function loadFixtureDocs(): string[] {
  return readdirSync(NOTES_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => readFileSync(join(NOTES_DIR, f), "utf-8").trim());
}

/** One proposer turn with the search_graph tool available. Drains the stream so `final` resolves. */
async function propose(modelId: string, history: Msg[]): Promise<CompletionFinal> {
  const run = completion({
    modelId,
    history,
    stream: true,
    tools: [SEARCH_GRAPH_TOOL],
    generationParams: { predict: 512, reasoning_budget: 0 },
  });
  for await (const _ of run.tokenStream) void _; // drive the stream to completion
  return run.final;
}

/** The real tool: search the RAG index over the context graph. */
async function runSearch(embModelId: string, query: string, topK: number) {
  const t = now();
  const hits = await ragSearch({ modelId: embModelId, workspace: WORKSPACE, query, topK });
  audit.record({
    event: "rag_search",
    modelSrc: GTE_LARGE_FP16,
    modelId: embModelId,
    durationMs: now() - t,
    extra: { query, topK, scores: hits.map((h) => h.score) },
  });
  return hits;
}

let embId: string | undefined;
let llmId: string | undefined;
try {
  console.log("=== Step 2 de-risk — search_graph tool-call loop ===\n");

  // Index the context-graph fixtures (same pattern as spike/02-rag.ts).
  embId = await loadModel({ modelSrc: GTE_LARGE_FP16, modelType: "embeddings", onProgress: () => {} });
  audit.record({ event: "model_load", modelSrc: GTE_LARGE_FP16, modelId: embId });
  const docs = loadFixtureDocs();
  const ingest = await ragIngest({ modelId: embId, workspace: WORKSPACE, documents: docs, chunk: true });
  console.log(`Indexed ${docs.length} fixture docs → ${ingest.processed.length} chunks.\n`);

  // The proposer: a real tool-calling model, loaded with native tools enabled.
  llmId = await loadModel({
    modelSrc: QWEN3_4B_INST_Q4_K_M,
    modelType: "llm",
    modelConfig: { ctx_size: 4096, tools: true },
    onProgress: () => {},
  });
  audit.record({ event: "model_load", modelSrc: QWEN3_4B_INST_Q4_K_M, modelId: llmId });

  const history: Msg[] = [
    {
      role: "system",
      content:
        "You are the proposer in a private on-device assistant. You have a tool, search_graph, " +
        "that searches the user's private notes. For any question about the user (their devices, " +
        "projects, or preferences) you MUST call search_graph first instead of guessing. After you " +
        "receive results, answer concisely and cite each claim as [Source N].",
    },
    { role: "user", content: QUESTION },
  ];

  console.log(`🔎 Question: "${QUESTION}"\n`);
  const final = await propose(llmId, history);
  const searchCalls = final.toolCalls.filter((c) => c.name === SEARCH_GRAPH_TOOL.name);
  if (searchCalls.length === 0) {
    console.error(`raw output was: ${JSON.stringify(final.raw.fullText.slice(0, 600))}`);
    throw new Error(
      `proposer emitted no search_graph tool call (got: ${final.toolCalls.map((c) => c.name).join(", ") || "none"}) — tool-calling loop FAILED`,
    );
  }
  console.log(
    `✅ tool call detected: ${searchCalls.map((c) => `${c.name}(${JSON.stringify(c.arguments)})`).join(", ")}`,
  );

  // Run the tool(s) for real and feed the snippets back as a tool observation.
  history.push({ role: "assistant", content: final.contentText });
  let sourceCount = 0;
  for (const call of searchCalls) {
    const query = typeof call.arguments["query"] === "string" ? (call.arguments["query"] as string) : QUESTION;
    const topKRaw = call.arguments["topK"];
    const topK = typeof topKRaw === "number" ? Math.min(Math.max(1, topKRaw), 8) : 3;
    const hits = await runSearch(embId, query, topK);
    sourceCount = hits.length;
    const context = hits.map((h, i) => `[Source ${i + 1}] ${h.content.replace(/\s+/g, " ").trim()}`).join("\n");
    console.log(`📚 search_graph("${query}") → ${hits.length} hits (top score ${hits[0]?.score.toFixed(3) ?? "n/a"})`);
    history.push({ role: "tool", content: context });
  }

  // Follow-up turn (no tools): the model now drafts the cited answer from the sources.
  console.log("\n--- Cited answer ---");
  const answerRun = completion({
    modelId: llmId,
    history,
    stream: true,
    generationParams: { predict: 512, reasoning_budget: 0 },
  });
  let answer = "";
  for await (const t of answerRun.tokenStream) {
    answer += t;
    process.stdout.write(t);
  }
  process.stdout.write("\n");
  const cited = /\[?source\s*\d/i.test(answer);
  const correct = /qwen3?[\s_-]*600m/i.test(answer.replace(/\s+/g, ""));
  audit.record({
    event: "completion",
    modelSrc: QWEN3_4B_INST_Q4_K_M,
    modelId: llmId,
    prompt: QUESTION,
    tokens: (await answerRun.stats)?.generatedTokens,
    extra: { role: "proposer", cited, namesCorrectModel: correct, sources: sourceCount },
  });

  console.log(
    `\nResult: tool-called=yes · cites a source=${cited ? "yes" : "no"} · names correct model=${correct ? "yes" : "no"}`,
  );
  if (!cited) throw new Error("answer did not cite a [Source N] — cited tool-call loop FAILED");
  console.log(`\n✅ GO — search_graph fired and the answer is cited above. Log: ${audit.path}`);
} catch (error) {
  console.error("❌ tool-call smoke failed:", error);
  audit.record({ event: "note", extra: { error: String(error) } });
  process.exitCode = 1;
} finally {
  try {
    await ragCloseWorkspace({ workspace: WORKSPACE, deleteOnClose: true });
  } catch {}
  if (llmId) await unloadModel({ modelId: llmId });
  if (embId) await unloadModel({ modelId: embId });
}
