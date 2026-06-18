// Abort-safety probe — replays the 2026-06-05 wedge test on a freshly-spawned 0.13.1 serve.
// Self-isolating: spawns its own serve on a spare port so the running stack is never touched.
//
// Sequence:
//   1. Spawn an isolated serve on PORT (default 11455); poll /v1/models until 200 (≤120s).
//   2. CONTROL: one clean streaming completion -> baseline TTFT + token flow.
//   3. ABORT:   start a streaming completion, read a few tokens, then abort the fetch
//               mid-decode (simulates client disconnect / Stop button).
//   4. PROBE:   immediately fire another same-model streaming completion.
//               PASS  = it streams tokens within DEADLINE_MS  (abort is safe on 0.13.1)
//               FAIL  = it hangs at zero tokens past DEADLINE_MS (old wedge persists)
//   5. Repeat the abort+probe a second time (the original bug compounded across aborts).
//   6. Kill the spawned serve in a finally.

import { spawn } from "node:child_process";

const PORT = process.env.PROBE_PORT ?? "11455";
const SERVE_URL = `http://127.0.0.1:${PORT}`;
// A freshly-spawned serve exposes models by their qvac.config alias (the long-running
// serve on :11435 may expose a different resolved id depending on how it was launched).
const MODEL = process.env.MODEL ?? "qwen3-4b";
const DEADLINE_MS = Number(process.env.DEADLINE_MS ?? 45_000);
const PROMPT = "Count from 1 to 300, one number per line. Do not stop early.";

// spawn an isolated serve (model cached; no network):
const serve = spawn("node", ["node_modules/@qvac/cli/dist/index.js", "serve", "openai", "--port", PORT],
  { cwd: "/Volumes/Development/qvac/mycelium/.claude/worktrees/mid-decode-cancel", stdio: "ignore" });

function now() { return Date.now(); }

// Start a streaming completion. Returns { ttft, tokens, aborted } once it ends or is aborted.
// onTokens(n) fires as tokens arrive; abortAfter (count) aborts after that many tokens.
async function stream(label, { abortAfter = Infinity, deadlineMs = DEADLINE_MS } = {}) {
  const ac = new AbortController();
  const started = now();
  let ttft = null;
  let tokens = 0;
  let aborted = false;
  let timedOut = false;

  const deadline = setTimeout(() => { timedOut = true; ac.abort(); }, deadlineMs);

  let res;
  try {
    res = await fetch(`${SERVE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        max_tokens: 600,
        messages: [{ role: "user", content: PROMPT }],
      }),
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(deadline);
    return { label, ttft: null, tokens: 0, aborted: true, timedOut, error: String(e?.message ?? e), ms: now() - started };
  }

  if (!res.ok || !res.body) {
    clearTimeout(deadline);
    return { label, ttft: null, tokens: 0, aborted: false, timedOut, error: `HTTP ${res.status}`, ms: now() - started };
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value, { stream: true });
      // Count SSE data frames that carry content deltas (including qwen3 <think> reasoning).
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const j = JSON.parse(payload);
          const d = j?.choices?.[0]?.delta;
          const piece = d?.content || d?.reasoning_content;
          if (piece) { if (ttft === null) ttft = now() - started; tokens++; }
        } catch { /* partial frame; ignore */ }
      }
      if (tokens >= abortAfter) {
        aborted = true;
        ac.abort();
        break;
      }
    }
  } catch (e) {
    // Abort throws here — expected when we abort or hit the deadline.
    aborted = aborted || ac.signal.aborted;
  } finally {
    clearTimeout(deadline);
    try { await reader.cancel(); } catch {}
  }
  return { label, ttft, tokens, aborted, timedOut, ms: now() - started };
}

function show(r) {
  const verdict = r.error ? `ERROR ${r.error}` : r.timedOut ? "TIMED OUT (no/low tokens)" : "ok";
  console.log(
    `  [${r.label}] ttft=${r.ttft ?? "—"}ms tokens=${r.tokens} aborted=${r.aborted} elapsed=${r.ms}ms ${verdict}`,
  );
  return r;
}

// Poll GET /v1/models until 200 (≤120s) before firing any requests.
async function waitForServe(url, timeoutMs = 120_000) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    try {
      const r = await fetch(`${url}/v1/models`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Serve did not come up at ${url} within ${timeoutMs}ms`);
}

(async () => {
  try {
    console.log(`Spawning isolated serve on port ${PORT}…`);
    await waitForServe(SERVE_URL);
    console.log(`Serve ready. Probing ${SERVE_URL} model=${MODEL} deadline=${DEADLINE_MS}ms\n`);

    console.log("1) CONTROL clean completion:");
    const control = show(await stream("control"));
    if (!control.tokens) {
      console.log("\n✗ Serve produced no tokens even on a clean request — environment problem, not abort-safety. Stopping.");
      process.exit(2);
    }

    const probes = [];
    for (let round = 1; round <= 2; round++) {
      console.log(`\n${round + 1}) ROUND ${round}: abort mid-decode, then probe next request:`);
      const ab = show(await stream(`abort#${round}`, { abortAfter: 5 }));
      if (!ab.aborted) console.log("   (note: stream finished before we could abort — prompt too short?)");
      // tiny gap so the abort's addon.cancel can propagate before the probe
      await new Promise((r) => setTimeout(r, 750));
      const probe = show(await stream(`probe#${round}`));
      probes.push(probe);
    }

    const wedged = probes.find((p) => !p.tokens || p.timedOut);
    console.log("\n" + "=".repeat(60));
    if (wedged) {
      console.log("✗ WEDGE REPRODUCED on 0.13.1 — a post-abort request produced no tokens.");
      console.log("  Conclusion: mid-decode cancel is STILL unsafe. Keep drain discipline.");
      process.exit(1);
    } else {
      console.log("✓ NO WEDGE — every post-abort probe streamed tokens.");
      console.log(`  Probe TTFTs: ${probes.map((p) => p.ttft + "ms").join(", ")}`);
      console.log("  Conclusion: mid-decode cancel is SAFE on 0.13.1. Real-cancel wiring is unblocked.");
      process.exit(0);
    }
  } finally {
    try { serve.kill(); } catch {}
  }
})();
