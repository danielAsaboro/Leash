# Mid-Decode Cancellation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "never abort, always drain" wedge discipline with real mid-decode cancellation that immediately frees the model/GPU — on local inference (web, desktop, mobile on-device) and on forward/mesh inference — keeping drain only as a fallback.

**Architecture:** Thread the `requestId` that `completion()` already returns through each request path and call `cancel({ requestId })` on Stop / client-disconnect / TTFB-timeout. For forward/mesh, add a `cancel` control message so a provider cancels its own local serve and bills actual tokens. The leash-broker stays as the cross-process serializer; the SDK's in-process FIFO queue handles same-process same-model concurrency.

**Tech Stack:** TypeScript (ESM, run via `tsx`), `@qvac/sdk@0.13.1`, Node 24, Vercel AI SDK (`ai` / `@ai-sdk/react`) for the web agent, React Native (JSC) for mobile, Hyperswarm/hyperdht for the mesh.

## Global Constraints

- **All inference goes through `@qvac/sdk` only** — never a cloud AI API.
- **SDK floor `@qvac/sdk@^0.13.0`** (installed 0.13.1). Cancel API: `completion(params): CompletionRun` exposes `run.requestId`; `cancel({ requestId })` (targeted) and `cancel({ modelId, kind })` (broad) are the only cancel surfaces. Both return after firing the registry abort.
- **No mocks/placeholders/stubs** — every committed change is real, working, QVAC-backed code. Test *fixtures* are fine; fake behavior is not.
- **License Apache-2.0**; ESM + TypeScript; `packages/*` libraries, `apps/*` clients.
- **Docs placement:** product docs only under `mycelium/docs/` (Mintlify `.mdx`); no other markdown scattered in `mycelium/` outside `docs/`. Probe scripts live in `spike/`, not repo root.
- **Drain stays as fallback** — do not delete drain paths; gate them behind "cancel could not be delivered/acked".
- **Never `npm install` in the background.** Git lives only on the mini; this checkout may not be a git repo — if `git commit` fails, record the commit message in the task and continue.

---

### Task 0: Sub-gate — prove HTTP serve cancel is safe + relocate probes

**Files:**
- Move: `abort-safety-inproc.ts` → `spike/abort-safety-inproc.ts`
- Move: `abort-safety-probe.mjs` → `spike/abort-safety-probe.mjs`
- Modify: `spike/abort-safety-probe.mjs` (count `<think>` content; spawn its own serve)

**Interfaces:**
- Produces: confirmation that aborting an HTTP completion mid-decode does not wedge a freshly-spawned 0.13.1 serve. Gates Tasks 2–4.

- [ ] **Step 1: Relocate both probe scripts out of repo root (Rule 6)**

```bash
cd /Volumes/Development/qvac/mycelium
mv abort-safety-inproc.ts spike/abort-safety-inproc.ts
mv abort-safety-probe.mjs spike/abort-safety-probe.mjs
```

- [ ] **Step 2: Make the HTTP probe self-isolating and think-aware**

In `spike/abort-safety-probe.mjs`: (a) start a dedicated serve on a spare port so the test is not confounded by the running stack; (b) count any non-empty `delta.content` OR `delta.reasoning_content` so qwen3 `<think>` tokens register as progress.

```js
// near the top, after the imports/consts:
import { spawn } from "node:child_process";
const PORT = process.env.PROBE_PORT ?? "11455";
const SERVE_URL = `http://127.0.0.1:${PORT}`;
// spawn an isolated serve (model cached; no network):
const serve = spawn("node", ["node_modules/@qvac/cli/dist/index.js", "serve", "openai", "--port", PORT],
  { cwd: "/Volumes/Development/qvac/mycelium", stdio: "ignore" });
// poll GET /v1/models until 200 (≤120s) before the CONTROL request, then run the existing
// control/abort/probe sequence against SERVE_URL, and kill `serve` in a finally.
```

In the token-counting loop, change the content check to:

```js
const d = j?.choices?.[0]?.delta;
const piece = d?.content || d?.reasoning_content;
if (piece) { if (ttft === null) ttft = now() - started; tokens++; }
```

- [ ] **Step 3: Run the isolated HTTP probe**

Run: `node spike/abort-safety-probe.mjs`
Expected: `✓ NO WEDGE — every post-abort probe streamed tokens.` (exit 0). If it prints `✗ WEDGE REPRODUCED`, STOP — the HTTP path still wedges; do not proceed to Tasks 2–4, report back.

- [ ] **Step 4: Confirm the in-process guard still passes from its new path**

Run: `npx tsx spike/abort-safety-inproc.ts`
Expected: `✓ NO WEDGE` (exit 0).

- [ ] **Step 5: Commit**

```bash
git add spike/abort-safety-inproc.ts spike/abort-safety-probe.mjs
git commit -m "test: relocate abort-safety probes to spike/ and isolate the HTTP probe serve"
```

---

### Task 1: Thread an AbortSignal/requestId through the shared web agent

**Files:**
- Modify: `apps/web/lib/leash/agent.ts` (the `ToolLoopAgentSettings` "NO abortSignal" invariant at ~`:12`, and `agent.stream` options)
- Modify: `apps/web/lib/leash/agent-runner.ts` (caller that builds call options)
- Test: `spike/abort-safety-inproc.ts` already covers the engine; add a focused agent-level assertion script `apps/web/lib/leash/__probes__/agent-cancel.probe.ts`

**Interfaces:**
- Consumes: `completion`/`cancel` from `@qvac/sdk` (via the existing serve transport the agent uses).
- Produces: `agent.stream({ messages, options, abortSignal })` now accepts `abortSignal`; when it fires, the in-flight completion is cancelled via `cancel({ requestId })`. Exposes the active `requestId` to the caller for logging.

- [ ] **Step 1: Read the current agent to find the exact omission point**

Run: `sed -n '1,60p' apps/web/lib/leash/agent.ts` and locate the `ToolLoopAgentSettings` construction + the `stream` entrypoint. Note the verbatim invariant comment block (`· NO abortSignal anywhere`).

- [ ] **Step 2: Write the failing agent-cancel probe**

Create `apps/web/lib/leash/__probes__/agent-cancel.probe.ts`:

```ts
// Asserts: aborting the agent's signal mid-turn stops token flow AND frees the model
// (a follow-up turn streams at baseline). Run: npx tsx apps/web/lib/leash/__probes__/agent-cancel.probe.ts
import { buildLeashAgent } from "../agent"; // adjust to the real export
const ac = new AbortController();
const agent = buildLeashAgent(/* minimal real deps */);
const turn = agent.stream({ messages: [{ role: "user", content: "Count to 400 slowly." }],
  options: { route: "chat" }, abortSignal: ac.signal });
let n = 0;
for await (const part of turn) { if (part.type === "text-delta") { n++; if (n === 5) ac.abort(); } }
const followup = agent.stream({ messages: [{ role: "user", content: "Name three colors." }],
  options: { route: "chat" } });
let m = 0, t0 = Date.now(), ttft = 0;
for await (const part of followup) { if (part.type === "text-delta") { if (!m) ttft = Date.now() - t0; m++; } }
if (m > 0) { console.log(`PASS follow-up streamed, ttft=${ttft}ms`); process.exit(0); }
console.log("FAIL follow-up produced no tokens"); process.exit(1);
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx tsx apps/web/lib/leash/__probes__/agent-cancel.probe.ts`
Expected: FAIL (today `agent.stream` ignores/omits `abortSignal`; either compile error on the unknown option or the follow-up queues behind the un-cancelled drain).

- [ ] **Step 4: Accept and thread `abortSignal` in the agent**

In `agent.ts`: remove the structural omission; add `abortSignal?: AbortSignal` to the stream options type. Capture the `requestId` from the `completion(...)` run, and register `abortSignal.addEventListener("abort", () => cancel({ requestId }).catch(() => {}), { once: true })`. Keep `maxRetries: 0` (a retry re-pays). Update the invariant comment to describe cancel-when-safe.

- [ ] **Step 5: Run the probe to verify it passes**

Run: `npx tsx apps/web/lib/leash/__probes__/agent-cancel.probe.ts`
Expected: `PASS follow-up streamed, ttft=<~baseline>ms`

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/leash/agent.ts apps/web/lib/leash/agent-runner.ts apps/web/lib/leash/__probes__/agent-cancel.probe.ts
git commit -m "feat(web): thread AbortSignal->cancel({requestId}) through the leash agent"
```

---

### Task 2: Wire web/desktop Stop + client-disconnect to a real cancel

**Files:**
- Modify: `apps/web/app/api/leash/chat/route.ts` (the `// DELIBERATELY no per-call abortSignal` block ~`:537`–`:568`)
- Modify: `apps/web/components/LeashChat.tsx` (`onStop={stop}` at `:780` — already calls `useChat.stop()`, which aborts the fetch; confirm the route observes it)

**Interfaces:**
- Consumes: `agent.stream({ abortSignal })` from Task 1.
- Produces: when the browser aborts (Stop) or disconnects, the route cancels the in-flight completion; GPU frees within one decode step.

- [ ] **Step 1: Derive an AbortSignal from the request and pass it to the agent**

In `route.ts`, build `const ac = new AbortController(); req.signal?.addEventListener("abort", () => ac.abort(), { once: true });` (Next route `req` is a `Request` with `.signal`). Pass `abortSignal: ac.signal` into the `agent.stream({ ... })` call (was deliberately omitted). Replace the `:537` comment with a cancel-when-safe note; keep a bounded drain fallback for the no-`requestId` window.

- [ ] **Step 2: Manual verification against the dev stack**

Run the web app, start a long generation, click Stop. Tail the serve/agent logs and confirm a `cancel`/abort log fires and the next message returns at baseline TTFT (not after a long drain).
Run: observe `apps/web` dev server logs + click Stop in the UI.
Expected: cancel logged; immediate next-turn responsiveness.

- [ ] **Step 3: Confirm desktop inherits it**

Desktop loads `apps/web` at `localhost:6801` (`apps/desktop/src/main/index.ts:28`) — no separate change. Launch desktop, repeat the Stop test.
Expected: same behavior as web.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/api/leash/chat/route.ts apps/web/components/LeashChat.tsx
git commit -m "feat(web/desktop): cancel the in-flight decode on Stop/disconnect instead of draining"
```

---

### Task 3: Cancel on the hypha local delegated path

**Files:**
- Modify: `apps/hypha/src/shim.ts` (delegated metered loop `:1043`–`:1066`; non-metered `:1136`–`:1209`; TTFB drain blocks; the `:12` wedge-discipline header)

**Interfaces:**
- Consumes: `completion(...).requestId`, `cancel({ requestId })`.
- Produces: on `!clientOpen` / `authStopped` / TTFB-timeout, the local delegated decode is cancelled, not drained. Forward path untouched (Task 6).

- [ ] **Step 1: Capture requestId at run start**

In both delegated branches, change `const run = completion({ ... })` to keep `run.requestId`. Add a helper `const stopDecode = () => cancel({ requestId: run.requestId }).catch(() => {})`.

- [ ] **Step 2: Replace the metered drain with cancel**

At `:1061`–`:1066`, where `if (!clientOpen) break;` then a background drain runs — call `stopDecode()` instead of the `void (async () => { for (… drain …) })()` loop. Keep the drain loop only as a fallback when `run.requestId` is undefined.

- [ ] **Step 3: Replace the TTFB-timeout drain with cancel**

At the `ttfb-timeout` blocks (`:1136`–`:1184` and the metered `:1045`–`:1056`), call `stopDecode()` instead of draining, then still `router.dropWarm(...)` so the pool re-warms.

- [ ] **Step 4: Update the header comment**

Rewrite `shim.ts:12` from "a delegated decode is NEVER cancelled — drain it" to "a local delegated decode is cancelled via `cancel({requestId})`; forward decodes drain unless the peer acks a cancel (Task 6)."

- [ ] **Step 5: Verify against an isolated hypha**

Run a delegated completion through the shim, disconnect the client mid-stream, then issue another. Confirm via logs that `cancel` fired and the second completes at baseline.
Run: hypha local delegated smoke (use the existing hypha launch from CLAUDE.md, session-attached).
Expected: cancel logged; no zero-token hang on the follow-up.

- [ ] **Step 6: Commit**

```bash
git add apps/hypha/src/shim.ts
git commit -m "feat(hypha): cancel local delegated decode on disconnect/TTFB instead of draining"
```

---

### Task 4: Broker cancels upstream on client disconnect

**Files:**
- Modify: `apps/leash-broker/src/main.ts` (`:303`–`:334` drain loop; header `:7,16,17,35`)

**Interfaces:**
- Consumes: serve cancel behavior confirmed in Task 0.
- Produces: on client disconnect the broker propagates the abort to the upstream serve fetch (so the serve sees the disconnect → registry cancel), draining only as fallback.

- [ ] **Step 1: Add an upstream AbortController tied to the client**

At the `undiciFetch(`${UPSTREAM}${url}`, { … })` call (`:303`), pass `signal: ac.signal` where `ac` aborts when `res`/`req` closes (`req.on("close", ...)`). This reverses the `// DELIBERATELY no abort signal` decision now that Task 0 proved the serve does not wedge.

- [ ] **Step 2: Keep the drain loop as fallback**

Leave the `reader.read()` drain loop (`:319`–`:334`) in place for the path where the client is still open; when the client is gone, abort upstream (Step 1) rather than draining to completion.

- [ ] **Step 3: Update broker header comments**

Rewrite `:7` (no longer "REJECTS concurrent … 500" — note the SDK now queues), and `:16`–`:17`,`:35` (wedge-safety → cancel-on-disconnect, drain fallback). Keep the per-alias serialization description.

- [ ] **Step 4: Verify with the broker in front of the isolated serve**

Start the broker against a spare-port serve, start a long completion through `:11436`, kill the client, then fire another same-alias request.
Run: `node spike/abort-safety-probe.mjs` with `SERVE_URL` pointed at the broker port.
Expected: `✓ NO WEDGE`.

- [ ] **Step 5: Commit**

```bash
git add apps/leash-broker/src/main.ts
git commit -m "feat(broker): abort upstream serve on client disconnect; drain only as fallback"
```

---

### Task 5: Tighten mobile on-device cancel to requestId

**Files:**
- Modify: `apps/mobile/App.tsx` (`stop` callback `:690`–`:699`)

**Interfaces:**
- Consumes: `cancel({ requestId })`; `run.requestId` captured at completion start.
- Produces: Stop cancels exactly the active turn (not all same-model work), keeping `cancel({ modelId })` as the broad fallback.

- [ ] **Step 1: Capture the active requestId**

Where the on-device `completion(...)` run is created, store `run.requestId` in a ref (`activeRequestIdRef`).

- [ ] **Step 2: Prefer requestId in `stop`**

In the `stop` callback, replace `void (cancel as any)?.({ modelId: id })…` with: if `activeRequestIdRef.current` → `cancel({ requestId: activeRequestIdRef.current })`; else fall back to `cancel({ modelId: id })`. Keep `agentAbortRef.current?.abort()` and `abortMeshForward()`.

- [ ] **Step 3: Verify on device/simulator**

Build per the mobile recipe (JSC; `DEVELOPER_DIR`, free-team signing). Start an on-device generation, tap Stop, confirm it halts promptly and a new generation works.
Expected: prompt stop; no stuck model.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/App.tsx
git commit -m "feat(mobile): cancel the active on-device turn by requestId, modelId as fallback"
```

---

### Task 6: Forward/mesh cancel protocol (provider cancels its own serve)

**Files:**
- Modify: `apps/mobile/forwardWorklet.ts` (`abortMeshForward` `:181`; surface provider `requestId` at stream start `:113`–`:128`,`:177`)
- Modify: `apps/hypha/src/shim.ts` (forward provider handler that runs `completion()` for a borrowing peer)
- Modify: `apps/hypha/src/forward-control.ts` (the control protocol both ends speak)

**Interfaces:**
- Consumes: `cancel({ requestId })` on the provider.
- Produces: a `cancel` control message `{ cancel: true, requestId }`; provider calls `cancel({ requestId })` on its local serve. Consumer falls back to today's disconnect-drain if no `{ cancelled: true }` ack within `FORWARD_CANCEL_ACK_MS` (define = 3000).

- [ ] **Step 1: Surface the provider's requestId to the consumer**

In the forward provider handler (shim forward path) that calls `completion(...)`, send the `run.requestId` to the consumer as the first control frame (e.g. `{ requestId }`) before tokens. In `forwardWorklet.ts:113`–`:128`, capture it into module state alongside `pending`.

- [ ] **Step 2: Define the cancel control message + ack**

Add to `forward-control.ts` a `cancel` message type `{ cancel: true, requestId: string }` and an ack `{ cancelled: true, requestId: string }`. Document the frame in the file header.

- [ ] **Step 3: Send cancel from the consumer**

Change `abortMeshForward()` (`forwardWorklet.ts:181`) to write `{ cancel: true, requestId }` (using the captured id) instead of the bare `{ abort: true }` disconnect. Start a `FORWARD_CANCEL_ACK_MS` timer; on timeout, fall back to the existing disconnect + local drain.

- [ ] **Step 4: Provider honors cancel**

In the shim forward handler, on receiving `{ cancel: true, requestId }`, call `cancel({ requestId })` on the local serve and reply `{ cancelled: true, requestId }`. Update the `:177` comment ("PROVIDER still drains … can't be hard-killed") to reflect that the provider now cancels on ack.

- [ ] **Step 5: Verify across two machines**

With the mini (provider) and Pro/mac3 (consumer) per CLAUDE.md, start a borrowed generation on the consumer, hit Stop, and confirm on the provider that its serve goes idle within `FORWARD_CANCEL_ACK_MS` (watch provider serve logs) — not draining to completion.
Expected: provider serve idle promptly; consumer logs the `{ cancelled: true }` ack.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/forwardWorklet.ts apps/hypha/src/shim.ts apps/hypha/src/forward-control.ts
git commit -m "feat(mesh): provider-side cancel of forward decode via {cancel,requestId} + ack, drain fallback"
```

---

### Task 7: Bill actual tokens when a metered forward session is cancelled

**Files:**
- Modify: `apps/hypha/src/payment-control.ts` (`openPaidSession` / `advanceAuthorization` / `closePaidSession`)
- Modify: `apps/hypha/src/shim.ts` (metered forward close path)

**Interfaces:**
- Consumes: the cancel ack from Task 6; the running token count at cancel time.
- Produces: a cancelled metered session settles at **actual tokens emitted**, not the quoted budget.

- [ ] **Step 1: Read the current settlement flow**

Run: `grep -n "openPaidSession\|advanceAuthorization\|closePaidSession\|settle" apps/hypha/src/payment-control.ts` and read those functions to learn how tokens-emitted feeds the on-chain close.

- [ ] **Step 2: Thread emitted-token count into close**

When a forward decode is cancelled (Task 6), pass the actual emitted-token count into `closePaidSession` so the settlement amount = `price_per_ktok * actualTokens/1000`, capped at the prior authorization. Keep the normal full-completion settlement unchanged.

- [ ] **Step 3: Verify billing on cancel**

Run a metered borrowed session, cancel after N tokens, and assert the settled amount corresponds to ~N tokens (read the audit JSONL + the on-chain close event).
Expected: settlement matches actual tokens, not the quote.

- [ ] **Step 4: Commit**

```bash
git add apps/hypha/src/payment-control.ts apps/hypha/src/shim.ts
git commit -m "feat(economy): settle cancelled metered forward sessions at actual tokens emitted"
```

---

### Task 8: Update docs, comments, and the stale CLAUDE.md note

**Files:**
- Modify: `mycelium/docs/agents/runtime.mdx`, `queue.mdx`, `queue-priority.mdx`, `plan-mode.mdx`
- Modify: `CLAUDE.md` (repo root — the `resources/qvac/` "broken partial clone" note)
- (Code comments were updated within Tasks 1–7; this task is the prose docs.)

**Interfaces:**
- Consumes: the shipped behavior from Tasks 1–7.
- Produces: docs that describe cancel-when-safe / drain-as-fallback and the corrected reference-clone note.

- [ ] **Step 1: Rewrite the four `.mdx` wedge paragraphs**

- `runtime.mdx`: "no `abortSignal` … serve wedges" → "`@qvac/sdk` 0.13.1 cancels in-flight decodes safely via `cancel({requestId})`; the runtime cancels on Stop/disconnect and drains only as a fallback."
- `queue.mdx`: "broker never aborts … drains to completion" → "broker aborts the upstream serve on disconnect; drains only when the client is still reading. Same-model concurrency is queued by the SDK in-process (FIFO, depth 64) and serialized cross-process by the broker."
- `queue-priority.mdx`: update the shared wedge-rule sentence to the cancel-first behavior.
- `plan-mode.mdx`: "A `generateText` mid-decode can't be aborted" → "mid-decode abort is supported (0.13.1); cancellation fires immediately and is also checked between steps."

- [ ] **Step 2: Correct the CLAUDE.md reference-clone note**

Change the `resources/qvac/` line from "a broken partial clone — do not use it; recommend deleting it" to: "`resources/qvac/` is a full, current clone of the SDK (fork `danielAsaboro/qvac`, ~v0.13.x) — usable as the upstream reference/pull-base."

- [ ] **Step 3: Verify docs build**

Run the Mintlify docs build/preview for `mycelium/docs` and confirm no broken `.mdx`.
Expected: docs render; edited pages reflect cancel-first behavior.

- [ ] **Step 4: Commit**

```bash
git add mycelium/docs/agents/runtime.mdx mycelium/docs/agents/queue.mdx mycelium/docs/agents/queue-priority.mdx mycelium/docs/agents/plan-mode.mdx CLAUDE.md
git commit -m "docs: cancel-when-safe/drain-as-fallback; correct resources/qvac reference-clone note"
```

---

## Self-Review

**Spec coverage:** Goals 1–4 map to tasks — local cancel (Tasks 1–3,5), broker (4), forward cancel (6), forward billing (7), queuing/broker-stays documented (4,8), drain-as-fallback (every task keeps it), docs + CLAUDE.md note (8). Sub-gate (spec §Verification) = Task 0. Non-goal (parallel same-model) explicitly excluded.

**Placeholder scan:** No "TBD/TODO". Where exact current code must be read first (large files: `route.ts`, `shim.ts`, `payment-control.ts`), the step says read the named line range, then shows the target change shape — because the literal current bytes are not reproduced in this plan. Implementers must Read those ranges before editing.

**Type consistency:** `run.requestId` (string) and `cancel({ requestId })` used uniformly across Tasks 1,3,5,6; broad `cancel({ modelId, kind })` only as fallback (Task 5). `FORWARD_CANCEL_ACK_MS = 3000` defined in Task 6 and consumed there; the `{ cancel: true, requestId }` / `{ cancelled: true, requestId }` frames defined in Task 6 §Step 2 and used in §Steps 3–4.

**Note on TDD shape:** This codebase verifies via runnable probes/smokes rather than a unit-test framework, so "failing test" steps use probe scripts and live-stack observation. Task 1 adds a dedicated agent-level probe; the engine-level guard is `spike/abort-safety-inproc.ts`.
