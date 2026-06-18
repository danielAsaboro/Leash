/**
 * In-process abort-safety probe — tests the SDK 0.13.1 cancel path directly,
 * with NO HTTP serve in the loop (so the serve's queue/think-buffering can't
 * confound the result). Uses the small 1B Llama (already cached) on the same
 * llamacpp-completion addon the chat model uses.
 *
 * Replays the 2026-06-05 wedge scenario:
 *   1. CONTROL — one clean completion runs to completion (baseline).
 *   2. ABORT   — start a long completion, read a few tokens, then
 *                `cancel({ requestId })` mid-decode.
 *   3. PROBE   — immediately start another completion; PASS iff it streams
 *                tokens within the deadline. (Old bug: it hung at 0 tokens.)
 *   4. Repeat abort+probe twice (the original bug compounded across aborts).
 *
 * Exit 0 = SAFE (no wedge), 1 = WEDGE reproduced, 2 = environment failure.
 */
import { completion, loadModel, cancel, close, LLAMA_3_2_1B_INST_Q4_0 } from "@qvac/sdk";

const DEADLINE_MS = Number(process.env.DEADLINE_MS ?? 30_000);
const now = () => Date.now();

interface Run { ttft: number | null; tokens: number; ms: number; note?: string }

// Drive a completion. If abortAfter is set, cancel({requestId}) after that many tokens.
// Enforces a first-token deadline so a wedge surfaces as ttft===null rather than a hang.
async function run(modelId: string, prompt: string, abortAfter = Infinity): Promise<Run> {
  const t0 = now();
  const r: any = completion({ modelId, history: [{ role: "user", content: prompt }], stream: true });
  let ttft: number | null = null;
  let tokens = 0;
  let note: string | undefined;

  const it = r.tokenStream[Symbol.asyncIterator]();
  try {
    for (;;) {
      const winner = await Promise.race([
        it.next(),
        new Promise<"deadline">((res) => setTimeout(() => res("deadline"), DEADLINE_MS)),
      ]);
      if (winner === "deadline") { note = "DEADLINE before token"; break; }
      if (winner.done) break;
      if (ttft === null) ttft = now() - t0;
      tokens++;
      if (tokens >= abortAfter) {
        await cancel({ requestId: r.requestId });
        note = `cancelled after ${tokens} tokens (requestId=${String(r.requestId).slice(0, 8)})`;
        break;
      }
    }
  } catch (e) {
    note = `iterator threw: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    try { await it.return?.(); } catch {}
  }
  return { ttft, tokens, ms: now() - t0, note };
}

function show(label: string, r: Run): Run {
  console.log(`  [${label}] ttft=${r.ttft ?? "—"}ms tokens=${r.tokens} elapsed=${r.ms}ms${r.note ? " · " + r.note : ""}`);
  return r;
}

(async () => {
  console.log("Loading 1B Llama in-process (cached)…");
  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    modelType: "llm",
    modelConfig: { device: "gpu", ctx_size: 4096 },
    onProgress: () => {},
  } as Parameters<typeof loadModel>[0]);
  console.log(`Loaded modelId=${modelId}\n`);

  console.log("1) CONTROL clean completion:");
  const control = show("control", await run(modelId, "Name three colors."));
  if (!control.tokens) {
    console.log("\n✗ No tokens on a clean in-process completion — environment problem, not abort-safety.");
    await close(); process.exit(2);
  }

  const probes: Run[] = [];
  for (let i = 1; i <= 2; i++) {
    console.log(`\n${i + 1}) ROUND ${i}: abort mid-decode, then probe:`);
    show(`abort#${i}`, await run(modelId, "Count slowly from 1 to 400, one number per line.", 5));
    await new Promise((r) => setTimeout(r, 500)); // let cancel propagate
    probes.push(show(`probe#${i}`, await run(modelId, "Name three animals.")));
  }

  const wedged = probes.find((p) => !p.tokens || p.ttft === null);
  console.log("\n" + "=".repeat(60));
  if (wedged) {
    console.log("✗ WEDGE REPRODUCED — a post-abort completion produced no tokens.");
    console.log("  mid-decode cancel is STILL unsafe on 0.13.1. Keep drain discipline.");
    await close(); process.exit(1);
  }
  console.log("✓ NO WEDGE — every post-abort probe streamed tokens.");
  console.log(`  Probe TTFTs: ${probes.map((p) => p.ttft + "ms").join(", ")}`);
  console.log("  mid-decode cancel is SAFE on 0.13.1. Real-cancel wiring is unblocked.");
  await close();
  process.exit(0);
})().catch(async (e) => {
  console.error("probe crashed:", e);
  try { await close(); } catch {}
  process.exit(2);
});
