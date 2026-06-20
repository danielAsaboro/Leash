# Tool Context Bloat Reduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce Leash chat latency and context bloat by exposing only the minimum tool schemas required for each routed lane while preserving QVAC dynamic-tools compatibility.

**Architecture:** Move active-tool selection out of `agent.ts` into a pure, testable policy helper. Route quick/plain turns to the `leash_keepalive` sentinel, route capability turns to their lane-specific tool group, and keep full/large registries behind explicit deep/tool lanes or skill execution. Add offline smoke coverage so schema-count regressions are caught without starting QVAC.

**Tech Stack:** TypeScript, Vercel AI SDK `ToolLoopAgent`, QVAC OpenAI-compatible local serve, existing npm/tsx smoke scripts.

---

### Task 1: Extract Active Tool Selection

**Files:**
- Create: `apps/web/lib/leash/tool-exposure.ts`
- Modify: `apps/web/lib/leash/agent.ts`
- Test: `scripts/smoke-tool-exposure.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing smoke**

Create `scripts/smoke-tool-exposure.ts` with assertions for:
- quick/lean chat exposes only `leash_keepalive`
- files route exposes only `bash`
- computer route exposes only Open Computer Use tools
- health route exposes only health tools
- default chat excludes computer, MCP-admin, and keepalive
- active skill tools expose declared tools plus skill-system tools and respect the cap

Run:

```bash
node --import tsx scripts/smoke-tool-exposure.ts
```

Expected before implementation: import failure because `tool-exposure.ts` does not exist.

- [ ] **Step 2: Add npm script**

Add:

```json
"smoke:tool-exposure": "tsx scripts/smoke-tool-exposure.ts"
```

- [ ] **Step 3: Implement pure selector**

Create `apps/web/lib/leash/tool-exposure.ts` exporting:

```ts
export const SKILL_TOOLS_CAP = 18;
export const SKILL_SYSTEM_NAMES = new Set(["read_skill", "read_skill_file", "run_skill_script", "run_skill"]);

export function resolveActiveToolNames(names: string[], options: {
  route: "chat" | "health" | "computer" | "files" | "vision";
  skillTools?: string[];
  leanTools?: boolean;
}): string[] { ... }
```

The implementation must preserve the existing behavior, except that it becomes directly testable.

- [ ] **Step 4: Wire `agent.ts` to helper**

Remove the local `resolveActiveTools`, `SKILL_TOOLS_CAP`, and `SKILL_SYSTEM_NAMES` from `agent.ts`. Import `resolveActiveToolNames` and call it in `prepareCall`.

- [ ] **Step 5: Verify**

Run:

```bash
node --import tsx scripts/smoke-tool-exposure.ts
npm run typecheck
```

Expected: both pass.

### Task 2: Add Lane Budget Helper

**Files:**
- Create: `apps/web/lib/leash/lane-budget.ts`
- Modify: `apps/web/app/api/leash/chat/route.ts`
- Test: `scripts/smoke-lane-budget.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing smoke**

Assert budgets:
- quick chat: `leanTools: true`, low token cap, one step
- files: route `files`, only files steps/token cap
- computer: route `computer`, computer budget
- active skill: skill budget
- plan: plan budget
- deep chat: not lean, larger budget

- [ ] **Step 2: Implement helper**

Move `steps`, `maxOutputTokens`, and `leanTools` derivation into a pure function.

- [ ] **Step 3: Wire route**

Replace inline `callOptions` budget branches with the helper.

- [ ] **Step 4: Verify**

Run smoke, typecheck, and a quick chat API probe.

### Task 3: Broker Design Slice

**Files:**
- Create: `apps/web/lib/leash/tool-brokers.ts`
- Test: `scripts/smoke-tool-brokers.ts`

- [ ] **Step 1: Add broker registry shape**

Represent each capability group as one schema:
- `files_run`
- `memory_run`
- `tasks_run`
- `context_run`
- `mcp_run`

Each broker validates an action enum and delegates to the existing tool implementation.

- [ ] **Step 2: Start with Files broker only**

Implement `files_run` over `bash` actions:
- `date`
- `find`
- `grep`
- `read_slice`

Keep raw `bash` available only in files lane and file-finder skill execution.

- [ ] **Step 3: Verify with smoke**

Offline smoke should assert one broker schema replaces raw file-search affordances in general chat.

### Task 4: Skill Dependency Health

**Files:**
- Create: `apps/web/lib/leash/skill-dependencies.ts`
- Modify: `apps/web/lib/leash/skill-tools.ts`
- Test: `scripts/smoke-skill-dependencies.ts`

- [ ] **Step 1: Write dependency smoke**

Assert `file-finder` reports unavailable if `bash` is absent, and available if Files MCP exposes `bash`.

- [ ] **Step 2: Implement dependency status**

Map built-in skill dependencies from `allowed-tools` to live tool names. Active skill selection should not inject a skill body when required tools are unavailable; it should surface a compact reason instead.

- [ ] **Step 3: Verify**

Run dependency smoke, typecheck, and focused `run_skill(file-finder)` chat probe.

### Task 5: Guard Semantics Cleanup

**Files:**
- Modify: `apps/web/lib/leash/conductor-core.ts`
- Modify: `apps/web/lib/leash/conductor.ts`
- Test: existing conductor tests or new `apps/web/scripts/conductor.test.ts` cases

- [ ] **Step 1: Add regression tests**

Test that phrases like “no tools needed” or “don’t use tools” do not force the full-agent tool path.

- [ ] **Step 2: Replace keyword-only guard**

Guard on action intent, not the literal word `tool`.

- [ ] **Step 3: Verify**

Run conductor tests and long-chat stress.

### Task 6: Acceptance

**Files:**
- Existing: `scripts/stress-long-chat-turn.ts`

- [ ] **Step 1: Run offline smokes**

```bash
npm run smoke:tool-exposure
npm run smoke:lane-budget
npm run smoke:skill-dependencies
npm run smoke:mcp
npm run typecheck
git diff --check
```

- [ ] **Step 2: Run live stress**

With QVAC and web running:

```bash
LEASH_WEB_BASE=http://127.0.0.1:6802 LEASH_STRESS_TURNS=30 node --import tsx scripts/stress-long-chat-turn.ts
```

Expected: 30/30 pass, with quick turns using direct/lean paths and no accidental 50+ tool exposure.
