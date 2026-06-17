# Phase B — Specialist delegates for the Leash orchestrator

**Date:** 2026-06-17
**Status:** Design — approved for planning
**Layer:** Mind (the Brain → Agents surface / chat route)
**Part of:** the unified-agents direction (everything is an agent; Leash is the default). See
[[agents-unified-architecture]]. **Phase A** ([2026-06-17-leash-default-agent-design.md](2026-06-17-leash-default-agent-design.md))
made the chat route load its base from `leash.md` via `loadMainAgentBase()`. Phase B builds on
that seam.

## Why

Phase A established that Leash's base is a markdown agent def. The product direction is a roster
of **specialist expert agents** (Health, Researcher, Summarizer, Coder) that the main assistant
calls when a request falls outside its generalist strength. Most of the machinery already exists
on `main`: the agent **store** (`data/leash-agents/<slug>.md`), the CRUD **dashboard**
(`AgentsPanel`), `/api/leash/agents` routes, **delegation** via `buildAgentTools` (8-agent cap,
one `agent__<slug>` tool per enabled agent), and an All/Built-in/Custom source **filter**. What's
missing is (a) the specialist roster itself, (b) seeding it as enabled builtin delegates, and (c)
teaching Leash *when* to delegate.

## The framing (locked during brainstorming)

**Leash is ALWAYS the main agent/orchestrator — it is not "switchable."** The specialists are
**expert delegates loaded ALONGSIDE Leash as sub-agents**, invoked by Leash when a request belongs
to a specialist's domain. They are full agents (could stand alone), but their role here is to be
called by Leash.

**Delegation is model-driven.** Leash decides to hand off by reading its (evolved) prompt + each
specialist's tool `description` — NOT by deterministic pre-routing. Concretely, Phase B **removes
the route's `isHealthIntent` regex** (the inline `MEDPSY_MODEL` swap + medpsy-suffix injection) and
replaces it with a **Health specialist agent**. The medical model + caveat move into that agent.

**Vision/computer routing is untouched.** Those are *modality* routing (which model can physically
handle an image / computer-use), orthogonal to *specialization*. They stay deterministic.

**No main-session switching, no Conductor rebuild, no frontmatter parity** (`mcpServers`/`memory`
are Phase C). The agent-as-main-session capability remains a latent/future generalization.

## Architecture

```
chat route (route.ts), per turn — UNCHANGED control flow except health removal:
  base = loadMainAgentBase()                       ← Phase A; still reads leash.md
  tools = { ...baseTools, ...buildSkillRunner, 
            ...buildAgentTools(enabledAgents),     ← already includes the seeded specialists
            ...planTool }
  (vision/computer modality routing unchanged; HEALTH branch REMOVED)

server-launch.mjs bootstrap:
  seedBuiltinSkills(scope)                          ← existing
  seedBuiltinAgents(scope)                          ← NEW: builtin-agents/*.md → data/leash-agents/
                                                       (seed-if-absent; SKIPS leash.md)
```

Leash (`loadMainAgentBase`, read-direct from `leash.md`) is the orchestrator and is **never** a
store agent or a delegate of itself. The 4 specialists live in `data/leash-agents/` and surface
through the existing `listAgents()` → `buildAgentTools()` delegation path automatically.

### Component 1 — The specialist roster (`apps/web/builtin-agents/*.md`)

Four new markdown agent defs, each `builtin: true`, parsed by the existing `buildAgent` path.
Specialization comes primarily from `model` + `description` (the delegation trigger) + `body` +
preloaded `skills`. `tools:` allow-lists are finalized at implementation against the real registry
(`leashTools`/`leashMcpTools`/skill tools) — no invented tool names.

| File | `name` | `model:` | `skills:` | `description:` (delegation trigger) |
|---|---|---|---|---|
| `health.md` (slug `health`) | **Joy** | `medpsy` | `context-grounding` | Medical, health, symptom, medication, and mental-health/wellbeing questions. |
| `researcher.md` (slug `researcher`) | **Sage** | *(empty ⇒ default)* | `deep-research` | In-depth, multi-source web research with citations on a topic. |
| `summarizer.md` (slug `summarizer`) | **Bree** | *(empty)* | — | Condense long documents, notes, or threads into concise summaries. |
| `coder.md` (slug `coder`) | **Grace** | *(empty)* | — | Write, debug, or explain code and scripts. |

> **Note on naming:** Each specialist has a human persona name (Joy/Sage/Bree/Grace) set in the `name:` frontmatter field. The **filename is the functional slug** (e.g. `health.md` → slug `health` → delegation tool `agent__health`) and is never changed — only the `name:` display field carries the persona. The `description:` field remains domain-based (not persona-based) as it is the delegation trigger Leash reads.

- **Health body** is the existing `DEFAULT_MEDPSY_SUFFIX` text (`apps/web/lib/leash/tools.ts`)
  expanded into a standalone medical-assistant system prompt, preserving the
  "not a substitute for a clinician" caveat verbatim.
- All ship `enabled: true` and `max-turns:` at a sane default (the store clamps 1–16).

### Component 2 — `builtin` flag on the agent model (`packages/leash-core/src/agents-store.ts`)

Mirror skills (`skills-store.ts:72,190`) exactly:
- Add `builtin: boolean` to the `Agent` interface.
- In `buildAgent(...)`: `builtin: fields["builtin"] === "true"`.
- In `serializeAgent(...)`: emit `builtin: true` when set, so a user-edited builtin stays builtin.

Plugin agents remain `source: "plugin"`; seeded markdown builtins are `source: "user"` **with
`builtin: true`** (identical to how builtin skills are user-store rows flagged builtin).

### Component 3 — `seedBuiltinAgents()` (`apps/web/server-launch.mjs`)

A direct parallel to `seedBuiltinSkills()` (lines ~211–225), called from `bootstrapScopeDir`
right after it:
- Source: `BUILTIN_AGENTS_SRC` (already resolved in Phase A, lines ~63–71).
- Destination: `join(scope.dataDir, "leash-agents")`.
- For each `*.md` in the source **except `leash.md`**: copy if the destination file is absent
  (seed-if-absent — user edits/deletes stick). Agents are flat `.md` files (not folders like
  skills), so iterate files, not directories.

### Component 4 — Leash prompt evolution (`apps/web/builtin-agents/leash.md`)

Append an orchestration paragraph to the existing body (skill guidance untouched). Phase A's
"verbatim" rule was a no-regression guard *for that merge only*; Phase B intentionally evolves the
prompt. Proposed addition:

> Beyond skills, you have SPECIALIST AGENTS — expert delegates for domains outside your generalist
> strength (medical/health, deep multi-source research, long-document summarization, coding). When
> a request squarely belongs to a specialist, delegate by calling its agent tool with a clear
> sub-task, let it work, then synthesize its result in your own voice. Handle general requests
> yourself; delegate when the specialist will clearly do better. Never expose the delegation
> mechanics to the user.

Because `loadMainAgentBase()` reads `leash.md` byte-for-byte, this change takes effect with no
other wiring. (The `DEFAULT_LEASH_SYSTEM` constant in `leash-defaults.ts` is the Phase A fallback;
it stays as the safety net — the live prompt is `leash.md`.)

### Component 5 — Route cleanup (`apps/web/app/api/leash/chat/route.ts`)

Remove the deterministic health path (model-driven delegation replaces it):
- Delete `HEALTH_RE` (line ~122) and `isHealthIntent` (lines ~124–126).
- Delete the `health` boolean (line ~307).
- Line ~353: `activeModel = imageTurn ? VISION_MODEL : computerTurn ? COMPUTER_MODEL : conductorDecision.route.alias || defaultAlias` (drop the `health ? MEDPSY_MODEL` term).
- Line ~381: `baseSystem = systemPrompt` (drop the `health ? … + getPrompt("medpsy")` term).
- Line ~549: drop the `health ? "health"` arm of the route-label expression.
- `MEDPSY_MODEL` import (line 15) and `getPrompt("medpsy")` become unused in the route — remove the
  now-dead references. Keep the `MEDPSY_MODEL` provider constant and the `medpsy` prompt key/
  `DEFAULT_MEDPSY_SUFFIX` text (the Health agent references the `medpsy` alias and reuses the
  caveat text) unless a wider sweep shows them fully unused.

### Component 6 — AgentsPanel: builtin filter + Main orchestrator card (`apps/web/components/AgentsPanel.tsx`)

- Filter predicate (lines ~72–78): treat builtin as `a.builtin || a.source === "plugin"`; custom as
  user-source non-builtin. Update the labels from `Plugin`/`User` toward `Built-in`/`Custom` to
  match the Skills panel (the source filter shipped in `636001a`).
- Surface **Leash** as a fixed **"Main orchestrator"** card sourced from `loadMainAgentBase()` (via
  a small server-provided prop or a dedicated read), shown above the delegate list — non-deletable,
  visually distinct. Leash is not in the store, so it is never in the delegate list or the
  custom/builtin counts.
- Seeded builtin specialists are editable (user-store rows), like builtin skills — not the plugin
  read-only path.

## Data flow

1. First launch → `seedBuiltinAgents()` copies the 4 specialists into `data/leash-agents/`.
2. Turn arrives → route builds tools, `buildAgentTools(listAgents().filter(enabled))` includes
   `agent__health`, `agent__researcher`, `agent__summarizer`, `agent__coder` alongside Leash's
   base tools.
3. Leash reads its evolved prompt + the specialists' tool descriptions and delegates when apt; the
   delegate runs its own sub-loop (its `model`, preloaded `skills`, `maxTurns`) and returns a
   summary Leash synthesizes.
4. A medical question now flows: Leash → `agent__health` (which runs on `medpsy`) → caveatted
   answer → Leash synthesis. No route-level health branch.

## Error handling

- `seedBuiltinAgents()` is best-effort per file (skip a bad entry, never abort bootstrap) — same as
  `seedBuiltinSkills()`.
- A malformed specialist `.md` (no frontmatter) is skipped by `parseUserAgent` (returns null) — it
  simply doesn't appear as a delegate; the rest are unaffected.
- Delegation cap (8) is not exceeded by 4 builtins + typical user agents; if it is, the existing
  warn-and-truncate behavior applies (unchanged).

## Testing

- **Parser:** `buildAgent` sets `builtin: true` from frontmatter; round-trips through
  `serializeAgent` (builtin preserved). Pattern: `node:assert` + `tsx`, mirroring
  `apps/web/scripts/main-agent.test.ts`.
- **Seed:** `seedBuiltinAgents()` seeds the 4 specialists into a temp data dir, is seed-if-absent
  (second run is a no-op), and **skips `leash.md`** (assert no `leash.md` in the destination).
- **Delegation surface:** with the specialists seeded+enabled, `buildAgentTools(listAgents())`
  emits `agent__health`/`agent__researcher`/`agent__summarizer`/`agent__coder`.
- **No-regression:** a general (non-specialist) turn behaves exactly as today; the route no longer
  references `health`/`MEDPSY_MODEL`/`getPrompt("medpsy")`.
- **Type-check:** `npx tsc -p apps/web --noEmit` and the leash-core package — only known
  pre-existing errors.
- **Manual e2e:** a medical question is answered via the Health delegate (medpsy, with caveat); a
  "research X deeply" request goes through the Researcher; a "summarize this" through Summarizer.

## Scope boundaries (YAGNI)

- No main-session switching / agent-as-main (latent future generalization).
- No change to vision/computer modality routing.
- No `mcpServers`/`memory`/`permissionMode` frontmatter parity (Phase C).
- No Conductor rebuild.
- Tools allow-lists kept minimal/default; specialization via model + description + body + skills.

## Open verification items (resolve during implementation; do not assume)

1. **Conductor health-bar interplay:** `conductor-utils.ts` `barFromFallback` maps health wording →
   a health specialist for the *main* turn. With model-driven delegation the main turn stays
   general (Leash). Confirm the Conductor doesn't fight the Health delegate (likely benign — it
   only influences which model Leash's own turn uses). **Do not rebuild the Conductor**; if it
   conflicts, prefer the smallest neutralizing change and flag it.
2. **medpsy constants sweep:** after the route cleanup, grep `MEDPSY_MODEL`, `getPrompt("medpsy")`,
   `DEFAULT_MEDPSY_SUFFIX` repo-wide; prune what's truly dead, keep what the Health agent reuses
   (the `medpsy` alias; the caveat text as the agent body's source).

## Build order

1. Add the `builtin` field to the `Agent` model + parser + serializer (+ parser test).
2. Author the 4 specialist `*.md` files (Health body from `DEFAULT_MEDPSY_SUFFIX`).
3. `seedBuiltinAgents()` in `server-launch.mjs` (+ seed test; skips `leash.md`).
4. Evolve `leash.md` with the delegation paragraph.
5. Route cleanup (remove the health regex/branches) + medpsy constants sweep.
6. AgentsPanel: builtin filter predicate + Main-orchestrator card.
7. Type-check + manual e2e (medical → Health delegate; research → Researcher).
