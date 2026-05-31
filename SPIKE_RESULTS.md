# Mycelium — Day 1–3 SDK Spike Results (the gate)

**Date:** 2026-05-31 · **SDK:** `@qvac/sdk@0.11.0` (Apache-2.0) · **Host:** Apple
Silicon Mac, Node v24.13, Metal GPU backend. All four risky QVAC primitives were
run for real on-device; outputs below are from the committed JSONL logs under
`spike/logs/` (the hackathon's audit-log evidence format).

## Verdict: **GO on all four.** Proceed to the Week-1 vertical slice.

| # | Primitive | Verdict | Logged-output snippet (real) | Doc relied on | Fallback if NO-GO |
|---|-----------|:------:|------------------------------|---------------|-------------------|
| a | On-device inference + embeddings | **GO** | LLAMA-3.2-1B streamed on GPU, **TTFT 56 ms, 70.6 tok/s**; GTE-large embedding **dim = 1024** | `resources/qvac-sdk-docs/api-reference.md` | none needed (core) |
| b | On-device RAG (grounded, cited) | **GO** | 3 docs → 7 chunks; **retrieval 23 ms**, top score **0.768**; no-context = *"I don't have any specific information about … Dani"* → grounded = *"According to the text, Dani runs the Raspberry Pi 5 … Rhizo"* (differs: **yes**) | `api-reference.md` (RAG section) | cache common queries |
| c | Encrypted P2P delegated compute | **GO** | consumer registered delegated model in **4.57 s** (cold DHT); tokens **generated on provider**, streamed back; **round-trip 1.27 s, TTFT 257 ms, 45.4 tok/s, device=gpu**; Noise-encrypted transport | `resources/qvac-sdk-docs/delegated-inference.md` | Mac two-process proof (used here) + `fallbackToLocal` |
| d | On-device LoRA (QVAC Fabric) | **GO** | fine-tune **COMPLETED in 152.7 s**, train_acc **0.86**, val_acc **0.85**; **20 MB adapter** produced + reloaded via `modelConfig.lora`; behavior changed (**base "Mesh" → adapter "Nexon"**) | `api-reference.md` (finetune section) | RAG-memory + adapter-merge, framed as memory not weights |

Each script prints to stdout **and** appends JSONL to `spike/logs/<name>.jsonl`
(model load/unload, prompt, tokens, TTFT, tok/s). Re-run any with `npm run spike:*`.

---

## (a) Inference + embeddings — GO

- **Streaming:** `LLAMA_3_2_1B_INST_Q4_0` streamed a coherent answer on the Metal
  GPU. Warm TTFT **56 ms**, **70.6 tok/s** (cold first-load TTFT was 466 ms).
- **Embeddings:** `GTE_LARGE_FP16` returned a **1024-dim** vector in ~84 ms.
- **Device-fit (this Mac, all on GPU):**

  | Model | Class | TTFT | tok/s |
  |---|---|---:|---:|
  | `QWEN3_600M_INST_Q4` | phone/Pi-class | 31 ms | **113.7** |
  | `LLAMA_3_2_1B_INST_Q4_0` | 1B | 52 ms | **74.7** |
  | `QWEN3_4B_INST_Q4_K_M` | Mac-class | 329 ms | **24.1** |

  Evidence (`spike/logs/01-inference.jsonl`):
  ```json
  {"event":"completion","modelSrc":{"name":"QWEN3_600M_INST_Q4",...},"device":"gpu","tokens":285,"ttftMs":31,"tokensPerSecond":113.7}
  {"event":"embedding","modelSrc":{"name":"GTE_LARGE_FP16",...},"extra":{"dim":1024}}
  ```

> **Correction found in the spike:** the constant `QWEN3_4B_Q4_K_M` (no `INST`) is a
> **diffusion** model (`sdcpp-generation`) — loading it as an LLM throws
> `MODEL_SRC_TYPE_MISMATCH`. The real Mac-class 4B chat LLM is
> **`QWEN3_4B_INST_Q4_K_M`**. Docs + scripts were corrected. (The plan inherited the
> wrong name.)

## (b) RAG — GO

Retrieval is rock-solid: the right chunk (Dani's Pi node) came back at score 0.768
in 23 ms, and grounding visibly changed the answer from "I don't know" to a
context-derived one. Citation precision varies run-to-run on the 1B model (one run
emitted `[Source N]` and named the exact model `QWEN3_600M`; another grounded
correctly without the citation tag) — exactly the small-model weakness the spec's
**council** (Layer 3) is designed to fix. RAG pipeline itself: **GO**.

```
🔎 Query: "Which model does Dani run on the Raspberry Pi node, and why?"
Retrieved 3 chunks in 23ms:  [1] score=0.768  [2] score=0.759  [3] score=0.688
NO-CONTEXT: I don't have any specific information about a person named Dani…
GROUNDED:   According to the text, Dani runs the Raspberry Pi 5 on the always-on edge node, Rhizo.
```

## (c) Encrypted P2P delegated compute — GO  *(the spec's riskiest item)*

Two Node processes on one Mac (deterministic, CI-able). Provider seed
`…c0ffee01` → public key `410d269e…43d0`. Consumer delegated to it; **tokens were
generated on the provider** and streamed back.

```
✅ Delegated model registered in 4572ms (cold-start incl. DHT bootstrap).
📨 Tokens (generated on the provider):
A weak device benefits from borrowing a stronger peer's brain by tapping into the
collective knowledge, experience, and processing power of another's device…
✅ Round-trip 1270ms · device=gpu · tok/s=45.4 · TTFT=257ms
```

- **Cold-start** (4.57 s on LAN) is well under the documented 15–45 s worst case.
- **Encryption:** Holepunch/Hyperswarm transport is Noise-encrypted by design.
- **Caveats (recorded):** no auto-reconnect yet (restart consumer if provider
  restarts); first-call cold start. `fallbackToLocal: true` is set for graceful degrade.

## (d) On-device LoRA via QVAC Fabric — GO

```
BASE answer:    Mesh
🔧 Fine-tune: epoch1 loss 2.73→1.71, epoch2 → 0.78;  COMPLETED in 152.7s
   stats: train_acc=0.86  val_acc=0.85  (32 steps, 2 epochs)
📦 Adapter produced: spike/results/trained-lora-adapter.gguf (20 MB)
ADAPTER answer: Nexon        (loaded via modelConfig.lora)
Behavior changed vs base: yes
```

The full loop works: train → save `.gguf` → reload via `modelConfig.lora` →
**observable behavior change**. The trivial 16-example × 2-epoch adapter on a 0.6B
model *shifted* the answer but did **not** memorize the exact target fact
("Hollowood" → it produced "Nexon"). That is a tuning matter (more examples/epochs,
higher effective LR) for the Week-3 evolution loop, **not** a primitive failure.
Notes captured along the way (now baked into the script): use `ctx_size ≥ 2048` and
`completion({ generationParams: { predict, reasoning_budget: 0 } })` to disable
QWEN3's chain-of-thought, otherwise inference overflows the context.

---

## Device-fit note

| Device | Status | Sizes that ran | Evidence |
|---|---|---|---|
| **This Mac** (Apple Silicon, Metal) | ✅ confirmed | `QWEN3_600M_INST_Q4` (113.7 tok/s), `LLAMA_3_2_1B_INST_Q4_0` (74.7), `QWEN3_4B_INST_Q4_K_M` (24.1) — all GPU | `spike/logs/01-inference.jsonl` |
| **iPhone / iPad** | ⏳ pending (manual) | scaffolded for Expo; run `01` device-fit + a real iPhone→Mac delegated consumer there | `apps/mobile/README.md` |
| **Raspberry Pi** | 🚫 deferred (no device yet) | recommend **≤1B Q4**: `QWEN3_600M_INST_Q4` (first choice) or `LLAMA_3_2_1B_INST_Q4_0` | Pi load-confirm = Week 2 |

- **RAM caveat:** models load in a separate **Bare worker process**, so Node's RSS
  shows ~0 MB delta — measure true model RAM via Activity Monitor / OS tools, not
  `process.memoryUsage()`. On-disk warm cache after the spike: **~4.0 GB**
  (`~/.qvac/models`).
- **Offline:** after the one-time warm download, all of (a) (b) (d) and the Mac↔Mac
  (c) run with no network. Run `npm run spike:warm` once online, then airplane-mode.

## Evidence bundle (committed)

- `spike/logs/01-inference.jsonl`, `02-rag.jsonl`, `03-p2p-consumer.jsonl`,
  `03-p2p-provider.jsonl`, `04-lora.jsonl` — raw audit records.
- `spike/results/trained-lora-adapter.gguf` — the produced LoRA adapter (20 MB;
  gitignored, regenerate with `npm run spike:lora`).

---

## STOP — gate decision

**All four primitives GO.** Per the design spec and `CLAUDE.md`, the Week-1 vertical
slice is **not** started until the user confirms these results.
