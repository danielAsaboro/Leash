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
| 1 — Mesh | QVAC P2P registry + delegated compute + **replicated CRDT context graph** | Week 1–2 ✓ (`MeshGraph`) |
| 2 — Senses | encrypted context graph + on-device RAG + voice STT | Week 1 ✓ |
| 3 — Mind | distributed council + delegated compute | Week 1 ✓ |
| 4 — Memory | nightly on-device LoRA (QVAC Fabric) | Week 3 |
| 5 — Clients | Mac dashboard + iPhone/iPad (Expo) app | Week 1–2 |
| — | `packages/shared` | foundation: shared types + logging (real) |

Each layer becomes a real `packages/<layer>` (or `apps/<client>`) workspace **when it
is actually implemented** — not before.

## Repo layout (current)

```
mycelium/
  packages/shared/      # foundation: DeviceCapability, AuditRecord, GraphNode, logger
  packages/senses/      # L2: context graph nodes + RAG index + voice STT + incremental embed
  packages/mind/        # L3: council (proposer+critic) + router + generic runAgent (tool registry)
  packages/mesh/        # L1: delegated-inference provider/consumer + MeshGraph (CRDT sync)
  apps/hub/             # the always-on "strong brain": provider + founding graph writer
  apps/edge-node/       # the weak "phone": classify → trivial-local / hard-delegated council
  apps/web/             # Leash dashboard (rail: Chat · Paper) + The Understory broadsheet
                        #   chat = Vercel AI SDK + @qvac/ai-sdk-provider (local qvac serve openai)
  spike/                # the de-risk gates — runnable, proven GO
    00-warm-cache.ts  01-inference.ts  02-rag.ts
    03-p2p-provider.ts  03-p2p-consumer.ts  04-lora.ts
    05-autobase-pairing.ts            # Week-2 CRDT graph-sync gate
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

## Run the mesh (Week 1–2: delegated council + replicated CRDT graph)

Two processes — the hub (strong brain) and an edge node (weak consumer) — sharing
**one replicated context graph** over multi-writer Autobase (Hypercore/Hyperbee),
synced P2P with no shared files. Heavy reasoning is delegated to the hub; light
retrieval stays local on the edge.

```bash
# Terminal A — the hub: starts a delegated-inference provider, opens the graph,
# mints a blind-pairing invite (printed + written to apps/hub/data/invite.txt).
# Optional MESH_GRAPH_SEED=<64hex> gives the mesh a stable key across fresh stores.
npm run hub

# Terminal B — the edge. First run pairs into the mesh (pass the invite, or it is
# read from apps/hub/data/invite.txt); later runs reopen as a permanent writer.
npm run ask -- "Which model does Dani run on the Pi, and why?" <hub-public-key> [<mesh-invite>]
```

The edge pairs, **replicates the hub's graph over CRDT**, embeds only the delta,
and delegates the council to the hub — which streams back a `[Source N]`-cited,
verifier-checked answer. A node sensed on either device becomes queryable on the
other (the hub live-embeds edge-synced nodes). Trivial queries (e.g. arithmetic)
are answered locally by `QWEN3_600M_INST_Q4` and never touch the hub.

Re-prove the CRDT graph sync in isolation (two terminals, bidirectional, offline):

```bash
npm run spike:autobase hub                 # prints an invite
npm run spike:autobase edge <invite>       # pairs → bidirectional sync → id-dedupe
npm run mesh:smoke hub                      # same, through the @mycelium/mesh package API
npm run mesh:smoke edge <invite>
```

## Run Leash (the assistant shell)

**Leash** is the headline app: a private, on-device assistant that "has access to
everything", powered by the same Mycelium engine. The Understory (the auto-written
paper) is one surface inside it. Leash is built on the **Vercel AI SDK** with QVAC as a
**local provider** (`@qvac/ai-sdk-provider`) — inference runs 100% on-device through a
local OpenAI-compatible QVAC server, so the "no cloud AI" rule holds.

```bash
# Terminal A — the on-device model server (from @qvac/cli). Reads qvac.config.json
# (serve.models: qwen3-4b chat + gte-large embeddings, tools enabled). 11435 avoids
# Ollama's default 11434.
npx @qvac/cli serve openai --port 11435

# Terminal B — the dashboard. Open http://localhost:6801 (→ /chat); "Paper" reaches
# The Understory. ⌘K still searches the archive.
npm run web:dev
```

The chat route (`app/api/leash/chat`) runs `streamText` with a real tool registry
(no mocks): `search_graph` (your private notes, RAG over the QVAC embeddings endpoint),
`understory_search` / `understory_today` (your paper), and `now`. Reasoning, tool calls,
and cited sources stream to the browser via the AI SDK UI-message protocol (`useChat`).
MCP servers listed in `LEASH_MCP_SERVERS` are merged in automatically — the drop-in path
for Home Assistant (P3) and the activity watchers (P2).

| env | default | where |
|---|---|---|
| `QVAC_OPENAI_URL` | `http://127.0.0.1:11435/v1` | web — the local QVAC server the provider targets |
| `LEASH_CHAT_MODEL` | `qwen3-4b` | web — chat model alias (must match `serve.models`) |
| `LEASH_EMBED_MODEL` | `gte-large` | web — embedding model alias for `search_graph` |
| `LEASH_MCP_SERVERS` | _(empty)_ | web — comma-separated MCP server URLs (HA/watchers later) |
| `LEASH_HA_URL` | _(empty)_ | web — Home Assistant base URL (e.g. `http://homeassistant.local:8123`); unset ⇒ HA tools report "not configured" |
| `LEASH_HA_TOKEN` | _(empty)_ | web — HA long-lived access token (stays server-side); required with `LEASH_HA_URL` |
| `LEASH_ACTIVITY_LOG` | `data/leash-activity.jsonl` | web + leash-watch — the screen watcher's activity trail (read by `active_context`/`activity_recent` and embedded into `search_graph`) |

### Agentic upgrades (skills · approval · MCP elicitation · kvCache)

**Skills** (Brain → Skills) follow the agentskills.io folder layout —
`data/leash-skills/<slug>/SKILL.md` + `references/` + `scripts/` + `assets/` (nested
paths, ≤3 deep). Import a packaged skill as a `.zip`; **imports and any SKILL.md without
an explicit `enabled: true` land DISABLED** (prompt-injection posture: review, then
enable). Enabled skills can bundle executable scripts the model runs via
`run_skill_script` — interpreter chosen by extension only (`.js/.mjs/.cjs` → node,
`.py` → python3, `.sh` → bash), argv spawn (no shell), realpath-contained to
`<skill>/scripts/`, stripped env, 60 s SIGKILL, 16 KB output caps. **This is real code
execution as the web-app user, not a sandbox** — which is why it's approval-gated:

**Tool approval** (Brain → Tools → "Ask first"): marked tools pause the chat on an
in-chat Approve/Deny card before running (`ha_call_service` and `run_skill_script`
default to ask-first). The pause ends the stream normally — the serve sits idle while
you decide; Deny is acknowledged, never retried. Malformed model tool-calls are
self-healed by `jsonrepair` (`experimental_repairToolCall`) before they ever error.

**MCP** (Brain → MCP): add MCP servers by URL (plus `LEASH_MCP_SERVERS` env rows,
read-only). Leash advertises the **elicitation** capability — when an MCP tool needs
the user mid-call, a form renders in the chat (string/number/boolean/enum), with a
120 s timeout-cancel so an unanswered form never hangs a tool. The bundled
`apps/leash-mcp` server (`:11439`, Services → "MCP (Mesh Tools)") turns mesh pairing
into chat: *"pair this device with my laptop"* discovers LAN devices and asks for the
6-digit PIN shown on the other machine's screen — input no model can know.
Limitations, honestly: voice turns don't speak approval/elicitation cards (answer them
on screen), and an elicitation holds its HTTP stream open while waiting (bounded by the
timeout; the serve can't be restarted during the wait).

**Delegated kvCache** (hypha): overflow turns shed to a mesh peer now reuse the peer's
KV cache across the conversation — the shim keys each session (`shim.*`) and only
reuses a key when the request provably extends exactly what the peer cached; edits,
regenerates, peer changes, errors, and restarts re-prime fresh (correctness over
speed). Evidence lands in `apps/hypha/logs/hypha.jsonl` as `cacheTokens` +
`extra.kvKey/kvFresh`. Kill switch `HYPHA_KV_CACHE=0`; hourly janitor TTLs each
device's own `~/.qvac/kv-cache/shim.*` (a session `.bin` runs tens of MB). The forked
serve also accepts an opt-in `kv_cache` body field (restored by `patch-package` from
`patches/`), but the web chat route deliberately doesn't send it: every text tier runs
tools-ON (the toolless-hang guard), and custom-key kv across tool-call turns is
unverified SDK territory. Hypha-only, on purpose. Note: a *cold* prime on a small fast
model barely moves TTFT — the win grows with history length.

## Offline acceptance test

After warming the cache, disable networking (airplane mode / pull the cable) and
re-run `spike:inference`, `spike:rag`, and the Mac↔Mac `spike:p2p:*` pair on one
machine. They must still produce tokens and grounded answers with zero connectivity.

## Hard rules

- **All inference via `@qvac/sdk` only** — never a cloud API.
- **Apache-2.0**, fully open-source and reproducible.
- See `../CLAUDE.md` for full repo conventions and the cached SDK docs under
  `../resources/qvac-sdk-docs/`.
