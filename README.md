# Mycelium

> A private, offline, **end-to-end-encrypted exocortex** that lives across your
> personal device mesh — it perceives your world, reasons above its weight, and
> grows from every interaction. Fully offline after a one-time warm-cache.
> Built entirely on **[`@qvac/sdk`](https://www.npmjs.com/package/@qvac/sdk)** for
> **QVAC Hackathon I — "Unleash Edge AI"** (Tether).

**Status:** ✅ **Day 1–3 SDK spike — GATE PASSED (all four primitives GO).** Results +
evidence live in [`../submission/SPIKE_RESULTS.md`](../submission/SPIKE_RESULTS.md).
The five product layers are built **for real, incrementally, in Week 1+** — there
are no stub layers in this repo; only working code ships. License: **Apache-2.0**.

## The idea

One private intelligence distributed across the mesh, in a closed loop:

```
SENSES ──► MIND ──► MEMORY ──► (sharper SENSES) ──┐
   ▲                                              │
   └──────────────────────────────────────────────┘
```

5 layers to be built (see `../docs/superpowers/specs/2026-05-31-mycelium-design.md`):

| Layer | Role | Status |
|---|---|---|
| 1 — Mesh | QVAC P2P registry + router/scheduler | Week 2 |
| 2 — Senses | encrypted context graph + on-device RAG | Week 1 |
| 3 — Mind | distributed council + delegated compute | Week 1 |
| 4 — Memory | nightly on-device LoRA (QVAC Fabric) | Week 3 |
| 5 — Clients | Mac dashboard + iPhone/iPad (Expo) app | Week 1–2 |
| — | `packages/shared` | foundation: shared types + logging (real) |

Each layer becomes a real `packages/<layer>` (or `apps/<client>`) workspace **when it
is actually implemented** — not before.

## Repo layout (current)

```
mycelium/
  packages/shared/      # foundation lib: DeviceCapability, AuditRecord, logger (real, used)
  spike/                # the Day 1–3 gate — runnable, proven GO
    00-warm-cache.ts  01-inference.ts  02-rag.ts
    03-p2p-provider.ts  03-p2p-consumer.ts  04-lora.ts
    lib/audit-log.ts  fixtures/  logs/  results/  checkpoints/
  qvac.config.json      # swarmRelays (blind relays)
```

Reporting/social/evidence artifacts live in `../submission/` (not in the code repo):
`SPIKE_RESULTS.md`, `build-in-public.md`. Cached SDK reference docs are in
`../resources/qvac-sdk-docs/`.

## Hardware setup

- **Mac** (mini / MacBook Pro) — compute hub + provider for delegated inference.
- **iPhone / iPad** — clients + sensors; delegated-compute consumers (via Expo).
- **Raspberry Pi** — always-on ambient edge node *(planned Week 2; no device yet)*.

Recommended model sizes by device class (confirmed in `../submission/SPIKE_RESULTS.md`):
phone/Pi → `QWEN3_600M_INST_Q4` or `LLAMA_3_2_1B_INST_Q4_0` (≤1B Q4);
Mac → up to `QWEN3_4B_INST_Q4_K_M` (note: `QWEN3_4B_Q4_K_M` without `INST` is a
diffusion model, not an LLM).

## Prerequisites

- Node ≥ 22 (developed on v24.13), npm 11+. `tsx` runs the TypeScript directly.
- Internet **once** to warm the model cache; offline thereafter.

```bash
cd mycelium
npm install
```

## Reproducibility — warm the cache (one-time, online)

The first run downloads GGUF weights from the QVAC registry and bootstraps the
P2P DHT. After this completes, every step below runs **fully offline**.

```bash
npm run spike:warm        # pre-downloads the spike's model weights
```

## Run the spike (the gate)

```bash
npm run spike:inference   # (a) on-device text streaming + embeddings + tok/s
npm run spike:rag         # (b) on-device RAG: grounded, cited answer
# (c) encrypted P2P delegated compute — two terminals:
npm run spike:p2p:provider        # prints a provider public key
npm run spike:p2p:consumer -- <provider-public-key>
npm run spike:lora        # (d) on-device LoRA via QVAC Fabric; base vs adapter
```

Each script prints to stdout **and** appends JSONL audit records under
`spike/logs/` (model load/unload, prompt, tokens, TTFT, tok/s). See
[`../submission/SPIKE_RESULTS.md`](../submission/SPIKE_RESULTS.md) for the recorded
GO/NO-GO and committed log excerpts.

## Offline acceptance test

After warming the cache, disable networking (airplane mode / pull the cable) and
re-run `spike:inference`, `spike:rag`, and the Mac↔Mac `spike:p2p:*` pair on one
machine. They must still produce tokens and grounded answers with zero connectivity.

## Hard rules

- **All inference via `@qvac/sdk` only** — never a cloud API.
- **Apache-2.0**, fully open-source and reproducible.
- See `../CLAUDE.md` for full repo conventions and the cached SDK docs under
  `../resources/qvac-sdk-docs/`.
