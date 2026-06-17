# Phase B: Specialist Delegates for the Leash Orchestrator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four specialist builtin agents (Health, Researcher, Summarizer, Coder) as markdown delegates that the Leash orchestrator calls when a request falls outside its generalist strength; replace the deterministic health regex with model-driven delegation.

**Architecture:** Leash stays the single main orchestrator (`loadMainAgentBase` reads `leash.md`). The four specialists are markdown agent defs seeded into the existing user-agent store (`data/leash-agents/`), where the existing `buildAgentTools` delegation path turns each enabled agent into an `agent__<slug>` tool alongside Leash automatically. A `builtin` flag (mirroring builtin skills) distinguishes them in the dashboard. Leash's prompt is evolved to delegate; the route's `isHealthIntent` branch is removed.

**Tech Stack:** TypeScript/ESM, `@mycelium/leash-core` agent store + `splitFrontmatter`, plain-JS bootstrap in `server-launch.mjs`, Next.js app-router, `node:assert` + `tsx` test scripts.

## Global Constraints

- **Leash is ALWAYS the main orchestrator** — never switched, never a delegate of itself. The seed step **skips `leash.md`**.
- **Delegation is model-driven** — Leash decides via its evolved prompt + each specialist's `description`. No deterministic pre-routing for health.
- **builtin agents mirror builtin skills** — `builtin: true` frontmatter; parsed by the same `buildAgent`; seeded **seed-if-absent** into `data/leash-agents/`.
- **`leash.md` body changes MUST be mirrored into `DEFAULT_LEASH_SYSTEM`** (`apps/web/lib/leash/leash-defaults.ts`) so the two stay byte-identical and `apps/web/scripts/main-agent.test.ts` keeps passing.
- **No invented tool names** — specialists leave `tools:` unset (sane default); specialization comes from `model` + `description` + `body` + `skills`. Only real skills (`context-grounding`, `deep-research`).
- **Do NOT rebuild the Conductor.** Vision/computer modality routing is untouched.
- **Known pre-existing tsc errors** (NOT introduced by this work): `apps/web/lib/leash/provider.ts` (TS2724 `LanguageModelV2Middleware`) and `apps/web/scripts/verify-data-dir-env.ts` (TS2345). Any OTHER new error must be fixed.
- **leash-core is consumed as BUILT `dist/`** — `@mycelium/leash-core/agents-store` resolves to `packages/leash-core/dist/agents-store.js` (Next does NOT transpile it from src). After ANY edit to `packages/leash-core/src/*`, you MUST rebuild (`npx tsc -b packages/leash-core`) before tests, `tsc -p apps/web`, or the dev server will see the change. This applies to Task 1 (and is a precondition for Tasks 2, 6, 7).
- **Branch:** `feat/leash-specialist-delegates` (already created; the spec is its first commit). One commit per task.
- Test idiom: `npx tsx apps/web/scripts/<name>.test.ts`, `node:assert`, prints `<name>: PASS`.

---

### Task 1: `builtin` field on the Agent model

**Files:**
- Modify: `packages/leash-core/src/agents-store.ts` (interface, `buildAgent`, `serializeAgent`, `saveAgent`)
- Create: `apps/web/scripts/agent-builtin.test.ts`

**Interfaces:**
- Consumes: existing `getUserAgent(slug)`, `saveAgent(input)`, `AGENTS_DIR` (env `LEASH_AGENTS_DIR`).
- Produces: `Agent.builtin: boolean`; `saveAgent` input accepts `builtin?: boolean`; `serializeAgent` emits `builtin: true` when set.

- [ ] **Step 1: Write the failing test**

Create `apps/web/scripts/agent-builtin.test.ts`:

```typescript
/**
 * tsx assertion script. Run: npx tsx apps/web/scripts/agent-builtin.test.ts
 * Verifies the `builtin` flag parses from frontmatter and round-trips through saveAgent.
 */
import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "agents-"));
  process.env["LEASH_AGENTS_DIR"] = dir; // AGENTS_DIR is read at module load — set BEFORE import
  const { getUserAgent, saveAgent } = await import("@mycelium/leash-core/agents-store");

  // 1. builtin: true in frontmatter parses to builtin === true
  writeFileSync(join(dir, "spec-one.md"), "---\nname: SpecOne\ndescription: d\nbuiltin: true\nenabled: true\n---\nbody");
  const a = await getUserAgent("spec-one");
  assert.ok(a, "spec-one should load");
  assert.strictEqual(a!.builtin, true, "builtin: true frontmatter → builtin === true");

  // 2. absent builtin → builtin === false
  writeFileSync(join(dir, "spec-two.md"), "---\nname: SpecTwo\ndescription: d\nenabled: true\n---\nbody");
  const b = await getUserAgent("spec-two");
  assert.strictEqual(b!.builtin, false, "no builtin frontmatter → builtin === false");

  // 3. saveAgent({ builtin: true }) round-trips (serializeAgent preserves it)
  await saveAgent({ slug: "spec-three", name: "SpecThree", description: "d", body: "x", builtin: true });
  const c = await getUserAgent("spec-three");
  assert.strictEqual(c!.builtin, true, "saveAgent(builtin:true) → getUserAgent builtin === true");

  // 4. saveAgent without builtin defaults to false
  await saveAgent({ slug: "spec-four", name: "SpecFour", description: "d", body: "x" });
  const d = await getUserAgent("spec-four");
  assert.strictEqual(d!.builtin, false, "saveAgent without builtin → builtin === false");

  rmSync(dir, { recursive: true });
  console.log("agent-builtin: PASS");
}
main();
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `cd /Volumes/Development/qvac/mycelium && npx tsx apps/web/scripts/agent-builtin.test.ts`
Expected: FAIL — `a.builtin` is `undefined` (assertion 1) or a type/import error, because `builtin` is not yet on the model.

- [ ] **Step 3: Add `builtin` to the `Agent` interface**

In `packages/leash-core/src/agents-store.ts`, in the `Agent` interface (after the `enabled` field), add:

```typescript
  /** Ships with the app (frontmatter `builtin: true`) vs. user-created. Mirrors builtin skills. */
  builtin: boolean;
```

- [ ] **Step 4: Parse `builtin` in `buildAgent`**

In `buildAgent(...)`, in the returned object (after the `enabled:` line), add:

```typescript
    builtin: fields["builtin"] === "true",
```

- [ ] **Step 5: Emit `builtin` in `serializeAgent` and accept it in `saveAgent`**

In `serializeAgent`, widen the `Pick<Agent, ...>` parameter type to include `"builtin"`, and after the `enabled` line in the `fm` string, emit it when set. The function header becomes:

```typescript
function serializeAgent(a: Pick<Agent, "name" | "description" | "body" | "model" | "tools" | "disallowedTools" | "skills" | "maxTurns" | "enabled" | "builtin">): string {
```

and after `let fm = \`name: ...\nenabled: ${a.enabled}\n\`;` add:

```typescript
  if (a.builtin) fm += `builtin: true\n`;
```

In `saveAgent`, add `builtin?: boolean;` to the input type (after `enabled?: boolean;`), and add `builtin: input.builtin ?? false,` to the `a` object (after the `enabled:` line). The returned `{ slug, source: "user", pluginId: "", ...a }` then carries `builtin`.

- [ ] **Step 6: Rebuild leash-core (the test imports the built `dist/`)**

The test imports `@mycelium/leash-core/agents-store`, which resolves to `dist/`. Rebuild so `builtin` is present in the compiled output and the `.d.ts`:

```bash
cd /Volumes/Development/qvac/mycelium && npx tsc -b packages/leash-core
```
Expected: builds clean. If `tsc -b` errors because an `Agent` object literal elsewhere in leash-core now lacks `builtin` (the most likely site is the plugin-agent surfacing in `packages/leash-core/src/plugins-store.ts`), fix that construction to include `builtin: false` (plugin agents are distinguished by `source`, not the flag) and rebuild. This build is also the leash-core type-consistency check for the new field.

- [ ] **Step 7: Run the test — verify it passes**

Run: `npx tsx apps/web/scripts/agent-builtin.test.ts`
Expected: `agent-builtin: PASS`

- [ ] **Step 8: Type-check the web app**

Run: `npx tsc -p apps/web --noEmit 2>&1 | grep "error TS"`
Expected: only the 2 known pre-existing errors (now that leash-core dist carries `builtin`).

- [ ] **Step 9: Commit**

```bash
git add packages/leash-core/src/agents-store.ts packages/leash-core/src/plugins-store.ts apps/web/scripts/agent-builtin.test.ts
git commit -m "feat(agents): add builtin flag to the agent model (mirrors builtin skills)"
```
(Include `plugins-store.ts` only if Step 6 required editing it. The rebuilt `dist/` is generated, not committed — it is gitignored; do not add it.)

---

### Task 2: The four specialist markdown files

**Files:**
- Create: `apps/web/builtin-agents/health.md`, `researcher.md`, `summarizer.md`, `coder.md`
- Create: `apps/web/scripts/specialist-agents.test.ts`

**Interfaces:**
- Consumes: `Agent.builtin` (Task 1); `getUserAgent` reading from `LEASH_AGENTS_DIR`.
- Produces: four builtin agent defs with `name`, `description`, `builtin: true`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/scripts/specialist-agents.test.ts`:

```typescript
/**
 * tsx assertion script. Run: npx tsx apps/web/scripts/specialist-agents.test.ts
 * Verifies each specialist builtin-agent file parses with the expected name/model/builtin.
 */
import assert from "node:assert";
import { mkdtempSync, copyFileSync, readdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url)); // apps/web/scripts
const SRC = join(here, "..", "builtin-agents");

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "specialists-"));
  process.env["LEASH_AGENTS_DIR"] = dir;
  for (const f of readdirSync(SRC)) if (f !== "leash.md") copyFileSync(join(SRC, f), join(dir, f));
  const { getUserAgent } = await import("@mycelium/leash-core/agents-store");

  const expected: Record<string, { name: string; model: string }> = {
    health: { name: "Health", model: "medpsy" },
    researcher: { name: "Researcher", model: "" },
    summarizer: { name: "Summarizer", model: "" },
    coder: { name: "Coder", model: "" },
  };
  for (const [slug, exp] of Object.entries(expected)) {
    const a = await getUserAgent(slug);
    assert.ok(a, `${slug} should load`);
    assert.strictEqual(a!.name, exp.name, `${slug} name`);
    assert.strictEqual(a!.model, exp.model, `${slug} model`);
    assert.strictEqual(a!.builtin, true, `${slug} builtin`);
    assert.ok(a!.description.length > 10, `${slug} has a description (drives delegation)`);
  }
  rmSync(dir, { recursive: true });
  console.log("specialist-agents: PASS");
}
main();
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `npx tsx apps/web/scripts/specialist-agents.test.ts`
Expected: FAIL — `health` (and the others) fail to load because the files don't exist yet.

- [ ] **Step 3: Create `apps/web/builtin-agents/health.md`**

```markdown
---
name: Health
description: Medical, health, symptom, medication, diagnosis, and mental-health or wellbeing questions. Delegate here whenever the user asks about symptoms, conditions, treatments, medications, test results, or emotional/mental wellbeing.
model: medpsy
builtin: true
skills: context-grounding
enabled: true
max-turns: 6
---
You are MedPsy, an on-device medical assistant. The current question is health, medical, or wellbeing related. Be accurate and concise, ground your answer in the user's own data through the tools when relevant, and always add a brief "not a substitute for a professional clinician" caveat. Do not give a definitive diagnosis; offer clear information and suggest seeing a clinician for anything serious, persistent, or worsening.
```

- [ ] **Step 4: Create `apps/web/builtin-agents/researcher.md`**

```markdown
---
name: Researcher
description: In-depth, multi-source web research with citations on a topic. Delegate here when the user wants a thorough investigation, a comparison, or up-to-date findings gathered and cross-checked across multiple sources.
builtin: true
skills: deep-research
enabled: true
max-turns: 8
---
You are a research specialist. Investigate the topic thoroughly using the deep-research capability: gather from multiple sources, cross-check claims, and synthesize a clear, well-cited answer. Prefer primary sources, distinguish established facts from contested claims, and say plainly when the evidence is thin.
```

- [ ] **Step 5: Create `apps/web/builtin-agents/summarizer.md`**

```markdown
---
name: Summarizer
description: Condense long documents, notes, transcripts, or threads into concise summaries. Delegate here when the user wants the key points of something lengthy.
builtin: true
enabled: true
max-turns: 4
---
You are a summarization specialist. Produce a faithful, concise summary that preserves the key points, decisions, and any action items. Lead with a one-line gist, then the essential points as tight bullets. Never add information that is not in the source, and flag anything genuinely ambiguous.
```

- [ ] **Step 6: Create `apps/web/builtin-agents/coder.md`**

```markdown
---
name: Coder
description: Write, debug, or explain code and scripts. Delegate here for programming tasks — implementing a function, fixing an error, explaining a snippet, or scaffolding code.
builtin: true
enabled: true
max-turns: 8
---
You are a coding specialist. Write correct, idiomatic, well-structured code. When debugging, find the root cause before proposing a fix. Explain your reasoning concisely and show complete, runnable code rather than fragments. Match the conventions of any existing code you are shown.
```

- [ ] **Step 7: Run the test — verify it passes**

Run: `npx tsx apps/web/scripts/specialist-agents.test.ts`
Expected: `specialist-agents: PASS`

- [ ] **Step 8: Commit**

```bash
git add apps/web/builtin-agents/health.md apps/web/builtin-agents/researcher.md apps/web/builtin-agents/summarizer.md apps/web/builtin-agents/coder.md apps/web/scripts/specialist-agents.test.ts
git commit -m "feat(agents): add Health/Researcher/Summarizer/Coder specialist builtin agents"
```

---

### Task 3: `seedBuiltinAgents()` in `server-launch.mjs`

**Files:**
- Modify: `apps/web/server-launch.mjs` (add `seedBuiltinAgents`, call it in `bootstrapScopeDir`)

**Interfaces:**
- Consumes: `BUILTIN_AGENTS_SRC` (already defined in Phase A, ~lines 63–71), `scope.dataDir`.
- Produces: `data/leash-agents/<slug>.md` for the 4 specialists on first launch; never `leash.md`.

**Note on testing:** `server-launch.mjs` runs under plain `node` and cannot import the TS store, so `seedBuiltinSkills` (the function this mirrors) has no unit test — it is verified by running the app. This task mirrors that pattern; its end-to-end verification is folded into **Task 7** (launch dev → inspect `data/leash-agents/`). The per-task check here is structural (faithful mirror of `seedBuiltinSkills`) + lint/run.

- [ ] **Step 1: Add `seedBuiltinAgents()` next to `seedBuiltinSkills()`**

In `apps/web/server-launch.mjs`, immediately after the `seedBuiltinSkills(scope)` function definition (ends ~line 225), add:

```javascript
/**
 * Seed the committed built-in AGENTS (apps/web/builtin-agents) into the user's agent store
 * (`<dataDir>/leash-agents/<slug>.md`), parallel to seedBuiltinSkills. These are the SPECIALIST
 * delegates (Health/Researcher/Summarizer/Coder) Leash can call. We SKIP `leash.md` — Leash is the
 * main orchestrator (read directly via lib/leash/main-agent.ts), never a delegate of itself.
 * Seed-if-ABSENT only, so a user editing or deleting a specialist sticks. Agents are flat `.md`
 * files (not folders like skills), so we copy files, not directories.
 */
function seedBuiltinAgents(scope) {
  if (!existsSync(BUILTIN_AGENTS_SRC)) return;
  const agentsDst = join(scope.dataDir, "leash-agents");
  mkdirSync(agentsDst, { recursive: true });
  for (const file of readdirSync(BUILTIN_AGENTS_SRC)) {
    if (file === "leash.md" || !file.endsWith(".md")) continue;
    const src = join(BUILTIN_AGENTS_SRC, file);
    const dst = join(agentsDst, file);
    try {
      if (!statSync(src).isFile() || existsSync(dst)) continue;
      cpSync(src, dst);
    } catch {
      /* skip a bad entry rather than abort the whole bootstrap */
    }
  }
}
```

- [ ] **Step 2: Call it in `bootstrapScopeDir`**

In `bootstrapScopeDir(scope)`, on the line right after `seedBuiltinSkills(scope);` (~line 175), add:

```javascript
  seedBuiltinAgents(scope);
```

- [ ] **Step 3: Smoke-run the launcher's module load (syntax + no throw at import)**

Run: `node --check apps/web/server-launch.mjs && echo "syntax ok"`
Expected: `syntax ok` (validates the new JS parses; full behavior verified in Task 7).

- [ ] **Step 4: Commit**

```bash
git add apps/web/server-launch.mjs
git commit -m "feat(agents): seed specialist builtin agents into the store on bootstrap (skips leash.md)"
```

---

### Task 4: Evolve Leash's prompt to delegate

**Files:**
- Modify: `apps/web/builtin-agents/leash.md` (append delegation paragraph to the body)
- Modify: `apps/web/lib/leash/leash-defaults.ts` (mirror the same text into `DEFAULT_LEASH_SYSTEM`)

**Interfaces:**
- Consumes: nothing new.
- Produces: an evolved Leash prompt; `leash.md` body and `DEFAULT_LEASH_SYSTEM` remain byte-identical (so `main-agent.test.ts` still passes).

**Critical:** `DEFAULT_LEASH_SYSTEM` is a single line with NO embedded newlines, and `apps/web/scripts/main-agent.test.ts` asserts `loadMainAgentBase().body === DEFAULT_LEASH_SYSTEM` byte-for-byte. You MUST append the SAME text to BOTH files, on the same single line (space-joined), or that test breaks.

The exact sentence to append (note the single leading space so it joins cleanly to the existing final sentence):

```
 Beyond skills, you also have SPECIALIST AGENTS — expert delegates for domains outside your generalist strength (medical and health questions, deep multi-source research, long-document summarization, and coding). When a request squarely belongs to a specialist, delegate to it by calling its agent tool with a clear sub-task, let it work, then synthesize its result in your own voice. Handle general requests yourself; delegate only when the specialist will clearly do better. Never expose the delegation mechanics or the specialist's name to the user — speak as one assistant.
```

- [ ] **Step 1: Append the sentence to `DEFAULT_LEASH_SYSTEM`**

In `apps/web/lib/leash/leash-defaults.ts`, the constant is a `+`-concatenation of string literals ending with the `"...say so plainly."` sentence. Add a new concatenated literal at the end (before the closing `;`):

```typescript
  " Beyond skills, you also have SPECIALIST AGENTS — expert delegates for domains outside your generalist strength (medical and health questions, deep multi-source research, long-document summarization, and coding). When a request squarely belongs to a specialist, delegate to it by calling its agent tool with a clear sub-task, let it work, then synthesize its result in your own voice. Handle general requests yourself; delegate only when the specialist will clearly do better. Never expose the delegation mechanics or the specialist's name to the user — speak as one assistant.";
```

(Change the previous literal's trailing `;` to `+` so the chain continues, and end the new literal with `;`.)

- [ ] **Step 2: Append the same text to `leash.md`**

In `apps/web/builtin-agents/leash.md`, append the same sentence to the END of the body line (the body is a single line; add the text — including its single leading space — directly after the final `...say so plainly.`). Do not introduce a line break.

- [ ] **Step 3: Verify byte-parity (the test's core invariant)**

Run:
```bash
node --input-type=module -e "
import { DEFAULT_LEASH_SYSTEM } from '/Volumes/Development/qvac/mycelium/apps/web/lib/leash/leash-defaults.ts';
import { readFileSync } from 'node:fs';
const raw = readFileSync('/Volumes/Development/qvac/mycelium/apps/web/builtin-agents/leash.md','utf8');
const body = raw.split(/\n---\n/)[1]?.trim() ?? '';
console.log('match:', body === DEFAULT_LEASH_SYSTEM, '| newlines:', DEFAULT_LEASH_SYSTEM.includes('\n'));
"
```
Expected: `match: true | newlines: false`. If `match: false`, the two texts diverged — fix until identical.

- [ ] **Step 4: Run the Phase A regression test (must still pass)**

Run: `npx tsx apps/web/scripts/main-agent.test.ts`
Expected: `main-agent: PASS` (test 1 — body === constant — now holds with both updated together).

- [ ] **Step 5: Commit**

```bash
git add apps/web/builtin-agents/leash.md apps/web/lib/leash/leash-defaults.ts
git commit -m "feat(agents): evolve Leash prompt to delegate to specialist agents"
```

---

### Task 5: Remove the deterministic health route + medpsy sweep

**Files:**
- Modify: `apps/web/app/api/leash/chat/route.ts`

**Interfaces:**
- Consumes: nothing new. Delegation already active via `buildAgentTools` (the Health agent is now a delegate).
- Produces: a route with no `health`/`isHealthIntent`/`MEDPSY_MODEL`/`getPrompt("medpsy")` references.

- [ ] **Step 1: Remove `HEALTH_RE` and `isHealthIntent`**

Delete the `HEALTH_RE` constant (~line 122) and the `isHealthIntent` function (~lines 124–126) in full.

- [ ] **Step 2: Remove the `health` boolean**

Delete `const health = !imageTurn && !filesTurn && !computerTurn && isHealthIntent(validated);` (~line 307).

- [ ] **Step 3: Drop the health terms from model + system selection**

- `activeModel` (~line 353) becomes:
  ```typescript
  const activeModel = imageTurn ? VISION_MODEL : computerTurn ? COMPUTER_MODEL : conductorDecision.route.alias || defaultAlias;
  ```
- `baseSystem` (~line 381) becomes:
  ```typescript
  const baseSystem = systemPrompt;
  ```
- Route label (~line 549): remove the `health ? "health" :` arm so it reads:
  ```typescript
    route: imageTurn ? "vision" : filesTurn ? "files" : computerTurn ? "computer" : "chat",
  ```

- [ ] **Step 4: Remove the now-unused `MEDPSY_MODEL` import**

On the provider import (~line 15), remove `MEDPSY_MODEL` from the named imports, leaving the others intact:

```typescript
import { CHAT_MODEL, VISION_MODEL, COMPUTER_MODEL, resolvedChatAlias, routedChatModel } from "../../../../lib/leash/provider.ts";
```

(If `grep -n "CHAT_MODEL" apps/web/app/api/leash/chat/route.ts` shows `CHAT_MODEL` is itself unused after this, remove it too — but only if unused.)

- [ ] **Step 5: Confirm health is fully gone and medpsy is swept**

Run:
```bash
cd /Volumes/Development/qvac/mycelium
grep -n "health\|isHealthIntent\|HEALTH_RE\|MEDPSY_MODEL\|getPrompt(\"medpsy\")" apps/web/app/api/leash/chat/route.ts || echo "route clean"
grep -rn "MEDPSY_MODEL\|DEFAULT_MEDPSY_SUFFIX\|\"medpsy\"" apps/web/lib apps/web/app | grep -v "builtin-agents" | head
```
Expected: `route clean` for the first. For the second, `MEDPSY_MODEL` (provider.ts constant) and `DEFAULT_MEDPSY_SUFFIX` / the `medpsy` prompt key may remain defined but now unused by the route — **keep them** (the `medpsy` alias is referenced by `health.md`'s `model:`, and the caveat text is the source for the Health agent body). Do NOT delete provider/prompt definitions in this task; only the route references are removed.

- [ ] **Step 6: Type-check**

Run: `npx tsc -p apps/web --noEmit 2>&1 | grep "error TS"`
Expected: only the 2 known pre-existing errors. Fix any new error (e.g. an unused-import error if the project enables `noUnusedLocals` — remove the offending import).

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/api/leash/chat/route.ts
git commit -m "feat(agents): replace deterministic health regex with model-driven delegation"
```

---

### Task 6: AgentsPanel builtin filter + Main-orchestrator card

**Files:**
- Modify: `apps/web/components/AgentsPanel.tsx` (client `Agent` type, filter predicate, labels, main card)
- Modify: `apps/web/app/brain/page.tsx` (pass the main-orchestrator prop)
- Modify: `apps/web/app/api/leash/agents/[slug]/route.ts` (preserve `builtin` through PUT)

**Interfaces:**
- Consumes: `Agent.builtin` (Task 1); `loadMainAgentBase()` from `apps/web/lib/leash/main-agent.ts` (Phase A) → `{ body, model, name }`.
- Produces: dashboard distinguishes builtin vs custom by the flag; Leash shown as a fixed non-deletable card; editing/toggling a builtin preserves its flag.

- [ ] **Step 1: Add `builtin` to the client `Agent` type and fix the filter**

In `apps/web/components/AgentsPanel.tsx`, add `builtin: boolean;` to the local `Agent` interface (the one mirroring the JSON, ~lines 21–34).

Replace the counts + visible filter (~lines 72–78) so builtin includes BOTH the flag and plugin source:

```typescript
  const isBuiltin = (a: Agent) => a.builtin || a.source === "plugin";
  const counts: Record<Visibility, number> = {
    all: agents.length,
    builtin: agents.filter(isBuiltin).length,
    custom: agents.filter((a) => !isBuiltin(a)).length,
  };
  const visible = agents.filter((a) => (filter === "all" ? true : filter === "builtin" ? isBuiltin(a) : !isBuiltin(a)));
```

Update the `VisibilityFilter` usage (~line 240) labels to match the Skills panel:

```typescript
          <VisibilityFilter value={filter} onChange={setFilter} builtinLabel="Built-in" customLabel="Custom" counts={counts} />
```

And the empty-state text (~line 253) to:

```typescript
          No {filter === "builtin" ? "built-in" : "custom"} subagents.
```

- [ ] **Step 2: Accept and render the Main-orchestrator card**

Change the component signature (~line 64) to also take the main agent:

```typescript
export function AgentsPanel({ agents, mainAgent }: { agents: Agent[]; mainAgent: { name: string } }) {
```

Render a fixed, non-deletable card at the top of the list area (just inside the panel body, above the agents map). Use the existing card/row styling idioms already in this file for visual consistency:

```tsx
      <div className="border p-3" style={{ borderColor: "var(--color-rule-strong)" }}>
        <p className="kicker" style={{ color: "var(--color-muted)" }}>Main orchestrator</p>
        <p style={{ fontFamily: "var(--font-body)" }}>{mainAgent.name}</p>
        <p className="kicker" style={{ color: "var(--color-faint)" }}>Always on — routes to the specialists below when a request is outside its strength.</p>
      </div>
```

- [ ] **Step 3: Pass the prop from the server page**

In `apps/web/app/brain/page.tsx`, add the import near the other lib imports:

```typescript
import { loadMainAgentBase } from "../../lib/leash/main-agent.ts";
```

Change the agents tab render (~line 93) to pass the main agent:

```tsx
      {tab === "agents" && <AgentsPanel agents={await listAgents()} mainAgent={{ name: loadMainAgentBase().name }} />}
```

- [ ] **Step 4: Preserve `builtin` through the PUT (edit/toggle) handler**

In `apps/web/app/api/leash/agents/[slug]/route.ts`, the `PUT` handler reads `existing` and calls `saveAgent({...})`. Add `builtin` to that call so toggling enable/disable or editing a seeded builtin keeps its flag:

```typescript
      enabled: body.enabled ?? existing.enabled,
      builtin: existing.builtin,
```

(Insert the `builtin` line right after the `enabled` line in the `saveAgent({...})` argument.)

- [ ] **Step 5: Type-check**

Run: `npx tsc -p apps/web --noEmit 2>&1 | grep "error TS"`
Expected: only the 2 known pre-existing errors. Fix any new error (most likely: a call site of `<AgentsPanel ... />` missing the new required `mainAgent` prop — there is one, in `brain/page.tsx`, handled in Step 3).

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/AgentsPanel.tsx apps/web/app/brain/page.tsx "apps/web/app/api/leash/agents/[slug]/route.ts"
git commit -m "feat(agents): builtin filter + Main-orchestrator card in AgentsPanel; preserve builtin on edit"
```

---

### Task 7: Whole-feature verification (type-check, tests, manual e2e)

**Files:** none (verification only).

- [ ] **Step 1: Run every Phase A + Phase B test**

```bash
cd /Volumes/Development/qvac/mycelium
npx tsx apps/web/scripts/agent-builtin.test.ts
npx tsx apps/web/scripts/specialist-agents.test.ts
npx tsx apps/web/scripts/main-agent.test.ts
npx tsx apps/web/scripts/conductor.test.ts
```
Expected: each prints `… PASS`.

- [ ] **Step 2: Type-check**

```bash
npx tsc -p apps/web --noEmit 2>&1 | grep "error TS" | sort | uniq
```
Expected: only `provider.ts` (TS2724) and `verify-data-dir-env.ts` (TS2345).

- [ ] **Step 3: Seed verification (the integration check Task 3 deferred)**

Start the dev server in a scratch data dir and confirm the specialists seed but `leash.md` does not:

```bash
cd /Volumes/Development/qvac/mycelium
LEASH_BASE="$(mktemp -d)" npm run dev &   # note the printed data dir, or derive from LEASH_BASE
# wait ~15s for bootstrap, then in another shell inspect the seeded agents dir:
#   find "$LEASH_BASE" -path '*/leash-agents/*.md'
# Expected: health.md researcher.md summarizer.md coder.md  — and NO leash.md
# Then stop the dev server.
```
Expected: `data/.../leash-agents/` contains `health.md`, `researcher.md`, `summarizer.md`, `coder.md`, and **not** `leash.md`. (Per the never-`npm install`-in-background rule, only `npm run dev` is launched here, never an install.)

- [ ] **Step 4: Manual delegation e2e**

With the dev server running and the four specialists enabled in Brain → Agents:
- Open the Brain → Agents tab: confirm the **Main orchestrator** card (Leash) at the top, the four specialists under **Built-in**, and the All/Built-in/Custom counts.
- In chat, ask a medical question (e.g. "what could cause a persistent dry cough?"): confirm the answer comes through the **Health** delegate (medpsy, with the clinician caveat) — watch for the `agent__health` sub-agent step in the stream.
- Ask "research the latest on X in depth": confirm the **Researcher** delegate runs.
- Confirm a plain general question is still answered by Leash directly (no delegation).

- [ ] **Step 5: Conductor-interplay observation (spec open item — observe, don't rebuild)**

The Conductor's `barFromFallback` (`apps/web/lib/leash/conductor-utils.ts`) maps health wording → a "health" specialist bar for the MAIN turn. With the route's health regex now gone, confirm this doesn't fight the Health delegate. During the medical-question e2e (Step 4), watch the server log line that records the Conductor decision / `activeModel` for the MAIN turn:
- **Expected/acceptable:** the main turn runs on the general chat alias and Leash delegates to `agent__health` (which runs on `medpsy`). 
- **If instead** the Conductor forces the MAIN turn onto `medpsy` on health wording (so Leash itself answers as medpsy AND may also delegate): record it as a finding for a follow-up decision. **Do NOT rebuild the Conductor in this plan** — note it for triage (a minimal future tweak to the health bar, out of Phase B scope).

Run `npx tsx apps/web/scripts/conductor.test.ts` to confirm the Conductor's deterministic tests still pass regardless.

- [ ] **Step 6: Final commit (if any verification fixes were needed)**

```bash
git add -A && git commit -m "test(agents): Phase B whole-feature verification" || echo "nothing to commit"
```

---

## Verification (summary)

- **Automated:** `agent-builtin`, `specialist-agents`, `main-agent`, `conductor` test scripts all PASS; `tsc -p apps/web` shows only the 2 known pre-existing errors.
- **Seed:** `leash-agents/` gets the 4 specialists, never `leash.md`; second launch is a no-op (seed-if-absent).
- **Delegation:** medical question → Health delegate (medpsy + caveat); research → Researcher; general → Leash direct.
- **No-regression:** `main-agent.test.ts` still passes (leash.md ≡ DEFAULT_LEASH_SYSTEM after both got the delegation paragraph); vision/computer routing untouched.
