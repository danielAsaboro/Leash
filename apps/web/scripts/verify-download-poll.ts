import assert from "node:assert/strict";
import { readDownloadStatus, type DownloadStatus } from "../lib/leash/download-poll.ts";

async function main(): Promise<void> {
  const okFetch: typeof fetch = (async () =>
    new Response(
      JSON.stringify({
        name: "QWEN3_4B_INST_Q4_K_M",
        state: "downloading",
        percentage: 12,
        downloaded: 120,
        total: 1000,
        pid: 123,
        startedAt: 1,
        updatedAt: 2,
      } satisfies DownloadStatus),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  const status = await readDownloadStatus("QWEN3_4B_INST_Q4_K_M", { fetchImpl: okFetch });
  assert.equal(status?.state, "downloading");

  const notFoundFetch: typeof fetch = (async () => new Response(JSON.stringify({ error: "no such download" }), { status: 404 })) as typeof fetch;
  assert.equal(await readDownloadStatus("QWEN3_4B_INST_Q4_K_M", { fetchImpl: notFoundFetch }), null);

  const transientFetch: typeof fetch = (async () => {
    throw new Error("Failed to fetch");
  }) as typeof fetch;
  assert.equal(await readDownloadStatus("QWEN3_4B_INST_Q4_K_M", { fetchImpl: transientFetch, tolerateTransientErrors: true }), null);

  let threw = false;
  try {
    await readDownloadStatus("QWEN3_4B_INST_Q4_K_M", { fetchImpl: transientFetch });
  } catch {
    threw = true;
  }
  assert.equal(threw, true);

  let serverError = false;
  try {
    await readDownloadStatus("QWEN3_4B_INST_Q4_K_M", {
      fetchImpl: (async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 })) as typeof fetch,
      tolerateTransientErrors: true,
    });
  } catch {
    serverError = true;
  }
  assert.equal(serverError, true);

  console.log("verify-download-poll: ok");
}

void main();
