/** Live public-compute benchmark through the real Hypha OpenAI-compatible product route. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const baseUrl = (process.env["LEASH_PUBLIC_BENCHMARK_URL"] ?? "http://127.0.0.1:12437/v1").replace(/\/+$/, "");
const trials = Math.max(2, Number(process.env["LEASH_PUBLIC_BENCHMARK_TRIALS"] ?? 8));
const concurrent = Math.max(1, Number(process.env["LEASH_PUBLIC_BENCHMARK_CONCURRENT"] ?? 4));
const ramLimitMb = Number(process.env["LEASH_PUBLIC_BENCHMARK_RAM_LIMIT_MB"] ?? 32 * 1024);
const coldStartDeclared = process.env["LEASH_PUBLIC_BENCHMARK_COLD_START"] === "1";

interface Trial {
  kind: "sequential" | "concurrent";
  temperature: "cold" | "warm" | "burst";
  trial: number;
  ok: boolean;
  status: number;
  elapsedMs: number;
  route?: string;
  jobId?: string;
  providerId?: string;
  discoveryMs?: number;
  connectionMs?: number;
  requesterTtftMs?: number;
  requesterTotalMs?: number;
  providerTtftMs?: number;
  tokensPerSecond?: number;
  tokens?: number;
  providerSystemUsedMb?: number;
  errorCode?: string;
  errorMessage?: string;
  rejected?: unknown[];
}

async function runTrial(kind: Trial["kind"], trial: number, temperature: Trial["temperature"]): Promise<Trial> {
  const started = performance.now();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "chat",
      messages: [{ role: "user", content: `Reply with exactly: PUBLIC BENCH ${kind.toUpperCase()} ${trial}` }],
      routeMode: "public",
      sensitivity: "shareable",
      stream: false,
      max_tokens: 32,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = await response.json().catch(() => ({})) as Record<string, any>;
  const routing = body["leash_routing"] as Record<string, any> | undefined;
  const result: Trial = {
    kind,
    temperature,
    trial,
    ok: response.ok,
    status: response.status,
    elapsedMs: Math.round(performance.now() - started),
    ...(routing ? {
      route: routing["route"],
      jobId: routing["jobId"],
      providerId: routing["providerId"],
      discoveryMs: routing["discoveryMs"],
      connectionMs: routing["connectionMs"],
      requesterTtftMs: routing["requesterTtftMs"],
      requesterTotalMs: routing["requesterTotalMs"],
      providerTtftMs: routing["ttftMs"],
      tokensPerSecond: routing["tokensPerSecond"],
      tokens: routing["tokens"],
      providerSystemUsedMb: Math.max(Number(routing["providerSystemUsedBeforeMb"] ?? 0), Number(routing["providerSystemUsedAfterMb"] ?? 0)),
    } : {
      errorCode: body["error"]?.["code"] ?? `http_${response.status}`,
      errorMessage: body["error"]?.["message"],
      ...(Array.isArray(body["error"]?.["rejected"]) ? { rejected: body["error"]["rejected"] } : {}),
    }),
  };
  if (result.ok) {
    assert.equal(result.route, "public", "successful public trial silently used another route");
    assert.ok(result.jobId && result.providerId, "successful public trial omitted routing identity evidence");
  }
  return result;
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}

const sequential: Trial[] = [];
for (let trial = 1; trial <= trials; trial++) sequential.push(await runTrial("sequential", trial, coldStartDeclared && trial === 1 ? "cold" : "warm"));
const burst = await Promise.all(Array.from({ length: concurrent }, (_, index) => runTrial("concurrent", index + 1, "burst")));
const results = [...sequential, ...burst];
const successes = results.filter((entry) => entry.ok);
const peakProviderSystemUsedMb = Math.max(0, ...successes.map((entry) => entry.providerSystemUsedMb ?? 0));
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  qvacOnly: true,
  routeIntent: "public",
  baseUrl,
  trials,
  concurrent,
  coldStartDeclared,
  summary: {
    attempts: results.length,
    successes: successes.length,
    successRate: successes.length / results.length,
    sequentialSuccessRate: sequential.filter((entry) => entry.ok).length / sequential.length,
    latencyMs: { p50: percentile(successes.map((entry) => entry.requesterTotalMs ?? entry.elapsedMs), 0.5), p95: percentile(successes.map((entry) => entry.requesterTotalMs ?? entry.elapsedMs), 0.95) },
    requesterTtftMs: { p50: percentile(successes.flatMap((entry) => entry.requesterTtftMs == null ? [] : [entry.requesterTtftMs]), 0.5), p95: percentile(successes.flatMap((entry) => entry.requesterTtftMs == null ? [] : [entry.requesterTtftMs]), 0.95) },
    coldRequesterTtftMs: percentile(successes.filter((entry) => entry.temperature === "cold").flatMap((entry) => entry.requesterTtftMs == null ? [] : [entry.requesterTtftMs]), 0.5),
    warmRequesterTtftMs: { p50: percentile(successes.filter((entry) => entry.temperature === "warm").flatMap((entry) => entry.requesterTtftMs == null ? [] : [entry.requesterTtftMs]), 0.5), p95: percentile(successes.filter((entry) => entry.temperature === "warm").flatMap((entry) => entry.requesterTtftMs == null ? [] : [entry.requesterTtftMs]), 0.95) },
    providerTtftMs: { p50: percentile(successes.flatMap((entry) => entry.providerTtftMs == null ? [] : [entry.providerTtftMs]), 0.5), p95: percentile(successes.flatMap((entry) => entry.providerTtftMs == null ? [] : [entry.providerTtftMs]), 0.95) },
    tokensPerSecond: { p50: percentile(successes.flatMap((entry) => entry.tokensPerSecond == null ? [] : [entry.tokensPerSecond]), 0.5), p95: percentile(successes.flatMap((entry) => entry.tokensPerSecond == null ? [] : [entry.tokensPerSecond]), 0.95) },
    peakProviderSystemUsedMb,
    ramLimitMb,
    withinRamLimit: peakProviderSystemUsedMb < ramLimitMb,
    failures: Object.fromEntries([...new Set(results.filter((entry) => !entry.ok).map((entry) => entry.errorCode ?? `http_${entry.status}`))].map((code) => [code, results.filter((entry) => !entry.ok && (entry.errorCode ?? `http_${entry.status}`) === code).length])),
  },
  results,
};

await mkdir(join(process.cwd(), "logs"), { recursive: true });
const reportPath = join(process.cwd(), "logs", `public-compute-benchmark-${Date.now().toString(36)}.json`);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, reportPath }, null, 2));

assert.ok(sequential.every((entry) => entry.ok), "one or more sequential public jobs failed");
assert.ok(report.summary.withinRamLimit, `provider system memory exceeded ${ramLimitMb} MB`);
