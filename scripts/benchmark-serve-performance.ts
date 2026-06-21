/** Warm QVAC OpenAI-serve TTFT/throughput benchmark with a machine-readable report. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const baseUrl = (process.env["QVAC_BENCHMARK_URL"] ?? "http://127.0.0.1:11435/v1").replace(/\/+$/, "");
const model = process.env["QVAC_BENCHMARK_MODEL"] ?? "chat";
const trials = Math.max(1, Number(process.env["QVAC_BENCHMARK_TRIALS"] ?? 5));
const maxTokens = Math.max(8, Number(process.env["QVAC_BENCHMARK_MAX_TOKENS"] ?? 64));

interface Trial {
  trial: number;
  ttftMs: number;
  durationMs: number;
  tokenDeltas: number;
  tokensPerSecond: number;
  finishReason: string | null;
}

async function runTrial(trial: number): Promise<Trial> {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with one compact sentence explaining why local inference preserves user control." }],
      stream: true,
      max_tokens: maxTokens,
      reasoning_budget: false,
      temperature: 0,
    }),
  });
  if (!response.ok) throw new Error(`serve returned ${response.status}: ${await response.text()}`);
  assert.ok(response.body, "serve returned no stream body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstTokenAt = 0;
  let tokenDeltas = 0;
  let finishReason: string | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const event of events) {
      const line = event.split("\n").find((entry) => entry.startsWith("data:"));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      const parsed = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }> };
      const choice = parsed.choices?.[0];
      if (typeof choice?.delta?.content === "string" && choice.delta.content.length > 0) {
        if (firstTokenAt === 0) firstTokenAt = performance.now();
        tokenDeltas++;
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    }
  }
  const finishedAt = performance.now();
  assert.ok(firstTokenAt > 0, "serve produced no visible token");
  const decodeSeconds = Math.max(0.001, (finishedAt - firstTokenAt) / 1000);
  return {
    trial,
    ttftMs: firstTokenAt - startedAt,
    durationMs: finishedAt - startedAt,
    tokenDeltas,
    tokensPerSecond: tokenDeltas / decodeSeconds,
    finishReason,
  };
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))]!;
}

const results: Trial[] = [];
for (let trial = 1; trial <= trials; trial++) results.push(await runTrial(trial));
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  qvacOnly: true,
  baseUrl,
  model,
  trials,
  maxTokens,
  summary: {
    ttftMs: {
      min: Math.min(...results.map((entry) => entry.ttftMs)),
      p50: percentile(results.map((entry) => entry.ttftMs), 0.5),
      p90: percentile(results.map((entry) => entry.ttftMs), 0.9),
      max: Math.max(...results.map((entry) => entry.ttftMs)),
    },
    tokensPerSecond: {
      min: Math.min(...results.map((entry) => entry.tokensPerSecond)),
      p50: percentile(results.map((entry) => entry.tokensPerSecond), 0.5),
      max: Math.max(...results.map((entry) => entry.tokensPerSecond)),
    },
  },
  results,
};

await mkdir(join(process.cwd(), "logs"), { recursive: true });
const reportPath = join(process.cwd(), "logs", `serve-performance-${Date.now().toString(36)}.json`);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, reportPath }, null, 2));
