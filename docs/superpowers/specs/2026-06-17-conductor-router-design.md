# Conductor — capability-first, cost-aware request router

**Date:** 2026-06-17
**Status:** Design — approved for planning
**Layer:** Mind (Layer 3), with execution plumbing through Mesh (broker → hypha)

## Why

The hackathon's **Capabilities** criterion scores "ability to handle multi-agent
workflows with orchestration and tool calling," and the **General Purpose** track
names "complex multi-agent systems with orchestration and tool calling" as its
first focus area. Today our routing is hardcoded: `route.ts` picks a model by regex
intent (image→qwen3vl, health→medpsy, computer-use→computer, else the user's chat
alias) and it is static for the whole turn. The mesh can already delegate inference
to peers, but that decision is made *silently* by the broker (queue depth) and
hypha's `MeshRouter` (tier) — the request never reasons about where it should run.

**Conductor** turns request placement into an explicit, agentic decision: a small
LLM classifies each turn, discovers what every reachable device can do (this device,
private mesh, public mesh) via MCP tools, hard-gates by sensitivity for privacy,
then ranks the survivors capability-first and cost-aware, and the chosen target is
actually executed via a new per-request routing directive. This lights up four
criteria at once — Capabilities (orchestration + tool calling), Innovation (P2P
scheduling), Performance (P2P load distribution across constrained devices), and the
privacy story (sensitive turns can never be priced onto a public peer).

## Decisions locked during brainstorming

1. **Routing model:** capability-first, cost-aware **ranking** — no fixed buckets.
   Every reachable option (local models + each peer's advertised model) is scored;
   the cheapest option that clears the classified capability bar wins.
2. **Classifier engine:** **hybrid.** A fast-path (`classifyEffort`: regex shortcut +
   gte-large embedding, ~ms, no model load) short-circuits obviously-trivial turns
   (greetings, simple math, tiny talk) straight to the cheapest local general route —
   no routing decode wasted. Every other turn runs the **Conductor**, a true
   agent — "an LLM in a loop with tools" — on the qwen3-1.7B already warm for
   `classify.ts`, which calls the discovery tools and emits a structured routing
   decision. The fast-path is a pure gate in front of the Conductor, not a competing
   classifier: it only *skips* the LLM for cases where placement obviously doesn't
   matter; anything ambiguous falls through to the Conductor.
3. **Scope:** **full scheduler** — classify modality + difficulty + sensitivity, then
   rank local specialists AND remote peers (e.g. delegate a vision turn to whichever
   mesh peer serves qwen3vl cheapest). Replaces the hardcoded intent routing as the
   *primary* path; today's regex rules are retained as a deterministic fallback if the
   Conductor errors or times out. **Tiers in scope now: device + private mesh.** The
   public-mesh tier is a documented extension seam (see Capability tags and Scope
   boundaries) — not built in this round.
4. **Sensitivity:** **hard gate by tier, applied before cost ranking.** Sensitive →
   device-only (and private-mesh, which is fully owned/trusted); the public tier is
   never eligible. Price can never override privacy. The gate logic already excludes
   the public tier, so enabling public mesh later changes nothing about the privacy
   guarantee.
5. **Execution:** **Approach A** — add one routing-directive pass-through
   (`x-leash-route {tier, peerKey, alias}`) threaded web → broker → hypha →
   `MeshRouter.route()`. Reuses all existing delegation, payment-grant, and warm-pool
   machinery. No web-side reimplementation of delegation.
6. **Tools live in MCP** — a net-new capability-discovery MCP server hosted in the
   existing `leash-tools-mcp` daemon, surfaced through `leashMcpTools()` like every
   other toolset.

## Architecture

```
user turn
  │
  ├─ fast-path gate (classifyEffort: regex + embedding, ~ms)
  │     obviously-trivial? → cheapest LOCAL general route, skip Conductor
  │     else ↓
  │
  ├─ Conductor (classifier-agent, qwen3-1.7B, warm)
  │     1. classify → { modality, difficulty, sensitivity }
  │     2. call discovery MCP tools → capability menu (device + private mesh)
  │     3. call rank_routes({ bar, sensitivity })   ← deterministic
  │            • HARD-GATE: drop tiers ineligible for this sensitivity
  │            • rank survivors: capability-bar-then-cost (price µ/ktok, inflight, latency)
  │     4. emit routing decision { tier, peerKey?, modelAlias, reason }
  │          └─ on error/timeout → deterministic intent routing (today's rules)
  │
  ├─ execute on chosen target
  │     • local  → serve :11435 with modelAlias
  │     • peer   → set x-leash-route header; broker forwards; hypha route() honours the pin
  │     • fallback chain: next-best ranked route → local → today's intent rules
  │
  └─ main answer streams; Conductor decision rendered as a visible turn step
```

### Component 1 — Capability-discovery MCP server

Net-new MCP server registered in the `leash-tools-mcp` daemon. Tools built this round:

- **`get_device_capability()`** → this device: `ramMB`, `computeClass`, `powerState`,
  `inflight`, and local served aliases with capability tags (modality, param-class,
  context window).
- **`list_private_mesh_models()`** → peers on private-tier meshes: per-alias
  `{ modelSrc, modality, paramClass, price.perKiloToken, inflight, latencyHint }`.
- **`rank_routes({ bar, sensitivity })`** → **deterministic, pure** policy function:
  applies the sensitivity tier gate, then ranks eligible routes capability-bar-then-cost.
  Returns an ordered list with scores and a human-readable reason per route. Pulling
  ranking into a testable pure function (not the LLM's free reasoning) is what keeps
  the system reliable and auditable.

Extension seam (not built now): **`list_public_mesh_models()`** — same shape, public
tier. Wiring it in later is purely additive: implement the tool, and (because public
peers serve models we can't derive tags for) read peer-advertised tags instead of the
local table (see below). The privacy gate already excludes the public tier, so it stays
correct the moment the tool returns rows.

Data sources already exist: `DeviceCapability` advertisements (`packages/shared`),
`MeshRouter`/`WarmPool` (`apps/hypha`), and hypha's peer info. The MCP server reads
these; it does not introduce a new source of truth.

**Capability bar & tags.** A route's *capability* is expressed as tags
(`modality: text|vision|audio`, `paramClass: tiny|small|mid|large`, specialist:
`general|health|vision|computer`, `contextWindow`). The classifier emits a *required*
bar; `rank_routes` keeps only routes whose tags satisfy it, then orders by cost.

**How tags are resolved (private mesh now → public mesh later).** Peers already
advertise the *alias strings* they serve (`DeviceCapability.models[].alias`). For the
private mesh, each device resolves tags locally from a single shared lookup table
(`packages/shared`): `aliasTags["qwen3vl"] = {modality:"vision", paramClass:"mid"}`,
`aliasTags["medpsy"] = {modality:"text", specialist:"health"}`,
`aliasTags["qwen3-4b"] = {modality:"text", paramClass:"small", specialist:"general"}`,
etc. No advertisement-schema change; works because on a private mesh we own every
device and therefore know every alias. The resolver is a single function
(`tagsForAlias(alias, advertisedTags?)`) so the **public-mesh extension** is localized:
when a peer advertises its own tags (a model we don't know), prefer those; otherwise
fall back to the local table. An alias with no entry and no advertised tags resolves to
`{modality:"text", paramClass:"unknown", specialist:"general"}` and is treated as a
last-resort general route.

### Component 2 — The Conductor agent

A `ToolLoopAgent` (same primitive as chat/subagents) on the warm qwen3-1.7B, with a
tight tool allow-list (the discovery tools + `rank_routes`) and a small step budget.
It runs at the **top of the turn for every non-trivial turn** (the fast-path gate
having already short-circuited obviously-trivial ones to a local route). Output is
structured: `{ modality, difficulty, sensitivity, decision: { tier, peerKey?,
modelAlias, reason } }`.

**Failure is non-fatal.** If the Conductor errors, times out, or returns malformed
output, the turn falls through to today's deterministic intent routing. This is the
explicit guard against regressions from replacing the hardcoded path.

### Component 3 — Execution plumbing (Approach A)

A single per-request routing directive carries the decision through the existing
pipeline without re-implementing delegation:

- **Web** (`route.ts`/`provider.ts`): when the decision is a peer route, attach
  `x-leash-route: { tier, peerKey, alias }` to the completion request and point at
  the broker (`:11436`).
- **Broker** (`apps/leash-broker`): forward the header verbatim to hypha (`:11437`)
  instead of relying solely on queue-depth overflow.
- **Hypha shim → `MeshRouter.route()`**: accept the pin (`peerKey`/`tier`) and select
  that peer/tier instead of the default tier walk. The pin is advisory-with-fallback:
  if the pinned peer is cold/unreachable, `route()` falls back to its normal ladder
  and the response surfaces which route actually served (so the UI never lies).

Local routes need no plumbing — they set `modelAlias` against serve `:11435` as today.

### UX

The Conductor's decision is rendered as a **visible turn step** in the chat UI
(classified tags + chosen route + reason + the ranked alternatives it rejected).
This is both the orchestration evidence for judging and a debugging surface. A
"why here?" expander shows the capability menu and the gate/ranking that produced
the pick.

## Data flow

1. `route.ts` receives the turn → invokes Conductor before assembling the main agent.
2. Conductor calls discovery MCP tools (via `leashMcpTools()`), then `rank_routes`.
3. Conductor returns the decision; `route.ts` records it to the audit log (JSONL:
   classified tags, chosen route, price estimate, fallback used y/n).
4. `route.ts` executes: local alias, or peer via `x-leash-route`.
5. Stream returns; UI renders the decision step and the answer.

## Error handling & reliability

- **Conductor failure** → deterministic intent routing (today's rules).
- **Pinned peer cold/unreachable** → `MeshRouter` ladder fallback → local.
- **Cost/capability tie** → prefer lower tier (more private) then lower price then
  lower inflight.
- **Sensitivity gate** is applied *before* ranking and is non-overridable by cost.
- Every decision and every fallback is written to the JSONL audit log (hackathon
  evidence requirement).

## Testing

- **`rank_routes` unit tests** (pure function): sensitivity gate correctness (a
  sensitive bar never yields a public route), capability-bar filtering, cost ordering,
  tie-breaks, empty-menu → local.
- **Classifier fixtures**: representative turns (greeting, heavy reasoning, vision,
  health, computer-use) → expected `{ modality, difficulty, sensitivity }` bands.
- **Plumbing integration**: an `x-leash-route` pin reaches `MeshRouter.route()` and
  selects the pinned peer; a cold pin falls back and the served route is reported.
- **Fallback**: a forced Conductor error yields the deterministic route; airplane-mode
  (no peers) always resolves to a local route.

## Scope boundaries (YAGNI for the 4-day window)

- No learned/online cost model — `rank_routes` is a hand-written deterministic policy.
- No speculative decoding or multi-peer split of a single turn.
- No new economy/settlement code — peer execution reuses the existing payment grant.
- No changes to how peers *advertise* capability beyond reading existing fields;
  tags are derived from known aliases via a shared table, not a new advertisement
  protocol.
- **Public mesh is not built this round.** `list_public_mesh_models` and
  peer-advertised tags are the documented extension seam; the privacy gate and the
  `tagsForAlias` resolver are written so adding public mesh is additive, not a rewrite.

## Build order

1. `rank_routes` pure policy + unit tests (no I/O — fastest, de-risks the core logic).
2. Capability-discovery MCP server (`get_device_capability`,
   `list_private_mesh_models`, plus `tagsForAlias` in `packages/shared`) reading
   existing sources; register in `leash-tools-mcp`.
3. Conductor agent + structured output + deterministic fallback; wire into `route.ts`
   ahead of the main agent, behind the `classifyEffort` fast-path gate (trivial turns
   skip the Conductor and route to the cheapest local general model).
4. `x-leash-route` pass-through: web → broker → hypha → `MeshRouter.route()`.
5. UI decision step + audit-log records.
6. End-to-end demo path on the real mesh (mini ↔ Pro ↔ mac3), captured for the video.
