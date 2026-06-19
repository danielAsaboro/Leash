# Design — Real mid-decode cancellation across web / desktop / mobile

**Date:** 2026-06-18
**Status:** Draft for review
**Supersedes:** the "wedge discipline" / "GPU-wedge rule" invariants that drain rather than
cancel an in-flight decode (encoded in `apps/web/app/api/leash/chat/route.ts`,
`apps/web/lib/leash/agent.ts`, `apps/leash-broker/src/main.ts`, `apps/hypha/src/shim.ts`,
`apps/mobile/*`, and `docs/agents/*.mdx`).

## Background

Every "Stop" / disconnect path in the stack deliberately **does not** abort the running
decode. It drains the remaining tokens in the background so the model finishes server-side,
because of an empirically-observed upstream bug, recorded verbatim in
`apps/web/app/api/leash/chat/route.ts:537`:

> *"DELIBERATELY no per-call `abortSignal` — the qvac serve WEDGES its LLM decode loop if the
> client disconnects mid-generation (verified 2026-06-05: one aborted request → every later
> generation hangs at zero tokens until the serve restarts; upstream SDK bug)."*

That bug was real on the 0.11-era SDK. The project now runs **`@qvac/sdk@0.13.1`** (declared
`^0.13.0`; reference clone `resources/qvac` is at 0.13.3 and is now a full, current clone —
the CLAUDE.md "broken partial clone" note is stale and must be corrected).

### What changed in the SDK

- **Cancel is a first-class, registry-backed op.** `cancel({ requestId })` (targeted) or
  `cancel({ modelId, kind })` (broad) walks the request registry and fires each in-flight
  request's `AbortSignal`; each handler has that signal wired to its addon-level unwind
  (`dist/server/bare/plugins/llamacpp-completion/ops/completion-stream.js` → `addon.cancel()`,
  with KV-boundary guards that refuse to commit a turn when `signal.aborted`, and slot release
  in a `finally`). `completion(...)` returns a `run.requestId` to pass to `cancel`.
- **Concurrent same-model requests queue instead of 500-ing.** The registry applies a
  `ConcurrencyPolicy` (completion default `{ maxConcurrentPerModel: 1, onOverflow: "queue",
  maxQueueDepthPerModel: 64 }`). The raw `@qvac/llm-llamacpp` addon still contains the
  `Cannot set new job` throw, but the registry queues upstream so it no longer surfaces.

### Verification already performed (2026-06-18)

An in-process probe (`abort-safety-inproc.ts`, 1B Llama, same `llamacpp-completion` addon)
ran: clean control → abort mid-decode via `cancel({ requestId })` → probe next completion,
twice. Result: **no wedge** — every post-abort probe streamed at baseline TTFT
(control 109ms; probe#1 102ms; probe#2 104ms). This clears the **in-process** path
(= mobile on-device) definitively. It did **not** re-prove the **HTTP serve client-disconnect**
path (web/desktop) because the live serve was contended; that becomes an explicit sub-gate
below.

## Goals

1. A Stop button (and client disconnect / TTFB timeout) **immediately frees the model/GPU**
   instead of paying for a full background drain — on **local** inference (web, desktop,
   mobile on-device) **and** on **forward/mesh** inference (a borrowed peer's serve).
2. Lean on the SDK's in-process FIFO queue so concurrent same-model requests queue gracefully
   rather than erroring; keep the broker for the cross-process coordination the SDK can't do.
3. Keep drain as an explicit, documented **fallback** for the cases cancel cannot cover.
4. Update every doc and code comment that asserts the old "never abort / serve wedges" rule.

## Non-goals

- True **parallel** same-model decode (continuous batching / llama.cpp slots). Both old and
  new SDK serialize to one decode per model; the new behavior is graceful queuing, not
  parallelism. The SDK serve config does not expose slots. Out of scope.
- Removing the leash-broker. It stays — it is the only cross-process serializer (web route,
  dream/research children, watcher are separate OS processes, each with its own in-process
  registry).

## Design

### Principle: cancel-when-safe, drain-as-fallback

Replace the unconditional drain with: **issue a real cancel; fall back to draining only when a
cancel cannot be delivered or acknowledged** (e.g. a model whose `addon.cancel` no-ops, or a
mesh peer that does not ack the cancel within a short window).

### Component A — Shared local request layer (web / desktop)

- `apps/web/lib/leash/agent.ts` (`ToolLoopAgent`): stop omitting `abortSignal` structurally;
  accept and thread a per-turn `AbortSignal`. On abort, call `cancel({ requestId })` for the
  active completion (the agent loop already checks cancellation between steps; this adds the
  in-step cancel).
- `apps/web/app/api/leash/chat/route.ts`: derive an `AbortSignal` from the client connection
  (`req` close) and pass it into `agent.stream`. Replace the drain comment/behavior at
  `:537`/`:568` with the cancel path; keep a bounded drain fallback.
- `apps/web/lib/leash/serve-control.ts` / `services.ts`: the "GPU-wedge guard" that refuses to
  restart/serve while a generation is in flight can relax once cancel is trusted; review each
  guard individually (do not blanket-remove).

### Component B — Broker (`apps/leash-broker/src/main.ts`)

- On client disconnect, instead of only draining upstream (`:308`–`:334`), forward a cancel to
  the serve for that request. Because the broker proxies the OpenAI HTTP API, this means either
  (a) propagating the abort to the upstream `undiciFetch` so the serve sees the disconnect, or
  (b) calling the serve's cancel surface keyed by the request. Confirm which the serve honors
  during the sub-gate. Keep the drain loop as the fallback path.
- Keep per-alias serialization and priority/aging — unchanged. Document that same-model
  concurrency is now also queued by the SDK in-process; the broker covers cross-process.

### Component C — Hypha shim (`apps/hypha/src/shim.ts`)

- **Local delegated path** (non-forward): thread the request's `AbortSignal`/`requestId` into
  `completion(...)` and call `cancel` on client-gone / `authStopped` / TTFB timeout
  (`:1061`–`:1066`, `:1136`–`:1184`) instead of the background drain. Keep drain as fallback.
- **Forward path**: see Component E.

### Component D — Mobile on-device (`apps/mobile/App.tsx`)

- Already calls `cancel({ modelId })` on Stop (`:690`–`:699`) and aborts the in-process agent
  loop — verified safe by the 2026-06-18 probe. Tighten to `cancel({ requestId })` for the
  active turn (avoids cancelling unrelated same-model work) where the requestId is available;
  keep `{ modelId }` as the broad fallback.

### Component E — Forward / mesh cancel (the substantive new work)

Today (`apps/mobile/forwardWorklet.ts:181`, `apps/hypha/src/shim.ts` forward path) a Stop sends
`{ abort: true }` to the local worklet which **disconnects the consumer side; the provider keeps
decoding to completion** (`forwardWorklet.ts:177`). To actually free the *provider's* GPU:

1. **Protocol:** extend the forward/payment-control message protocol with an explicit
   `cancel` control message carrying the in-flight `requestId` (the provider's
   `completion()` requestId, surfaced back to the consumer at stream start).
2. **Provider side:** on receiving `cancel`, the provider calls `cancel({ requestId })` on its
   local serve — proven safe by the same registry path. If no ack within a short timeout, the
   consumer falls back to today's disconnect-and-let-it-drain behavior.
3. **Billing:** for metered sessions, settle at **actual tokens emitted at cancel time**, not
   the quoted budget. Reconcile with `openPaidSession` / `advanceAuthorization` /
   `closePaidSession` in `payment-control.ts` so a cancelled session bills the partial decode.
   This is the part that needs the most care — a cancel must not under- or over-charge, and a
   provider must not be able to claim full payment for a cancelled decode.

### Component F — Docs & comments

Rewrite to "cancel-when-safe, drain-as-fallback", citing 0.13.1:

- `docs/agents/runtime.mdx` — "no `abortSignal` … serve wedges" → cancel is supported & safe.
- `docs/agents/queue.mdx` — "broker never aborts … drains to completion" → broker cancels,
  drains as fallback; SDK queues same-model in-process.
- `docs/agents/queue-priority.mdx` — same wedge-rule paragraph.
- `docs/agents/plan-mode.mdx` — "A `generateText` mid-decode can't be aborted" → it can now.
- Code comments: `route.ts:537,568`; `agent.ts:12–13`; `leash-broker/src/main.ts:7,16,17,35,308–321`;
  `shim.ts:12,1065,1147`; `forwardWorklet.ts:177`; `mobile/App.tsx:692`.
- `CLAUDE.md`: correct the stale "`resources/qvac/` is a broken partial clone — do not use it"
  note — it is now a full, current clone (fork `danielAsaboro/qvac`, ~0.13.3) usable as the
  pull-base reference.

## Verification plan

1. **Sub-gate (HTTP, idle serve):** quiesce the running consumers (or run a throwaway serve on
   a spare port), then run the HTTP variant of the abort probe (`abort-safety-probe.mjs`,
   counting `<think>` content) — confirm a post-abort same-model request streams at baseline
   TTFT. Gate web/desktop/broker changes on this.
2. **Per-component:** local cancel frees the serve within one decode step (assert next request
   TTFT ≈ baseline); concurrent same-model requests queue (no `Cannot set new job`).
3. **Forward/mesh:** consumer Stop → provider serve goes idle within a bounded window; metered
   session bills actual tokens; no-ack path falls back to drain.
4. **Regression guard:** keep `abort-safety-inproc.ts` as a runnable regression check (relocate
   out of repo root — proposed `spike/` or a test dir, per Rule 6).

## Resolved decisions (2026-06-18)

1. **Forward billing on cancel** — settle at **actual tokens emitted at cancel time**
   (fair-marketplace semantics; a provider cannot bill the full quote for a cancelled decode).
   `payment-control.ts` settlement must support partial-token close.
2. **Sub-gate method** — spin a **throwaway serve on a spare port** (e.g. `:11455`) for the
   idle HTTP abort test; leave the running web/hypha mesh untouched.
3. **Probe scripts** — keep both as regression guards, **relocated out of repo root** per
   Rule 6: `abort-safety-inproc.ts` → `spike/` as the committed in-process guard;
   `abort-safety-probe.mjs` (HTTP) alongside it for the sub-gate.
