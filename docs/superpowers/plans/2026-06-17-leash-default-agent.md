# Phase A: Leash as the Default Agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract Leash's static identity (base system prompt + default model + name) into a markdown agent definition at `apps/web/builtin-agents/leash.md`, loaded per-turn by the chat route — zero behavior change, pure seam for Phase B.

**Architecture:** A new `loadMainAgentBase()` function in `apps/web/lib/leash/main-agent.ts` reads and parses `leash.md` using the leash-core frontmatter splitter, returning `{ body, model, name }` with a constant-based fallback. The route calls it once per turn (synchronously) and sources its default system prompt and default model from the result; `getPrompt("system")` user overrides remain the highest-precedence layer. Every failure path in `loadMainAgentBase()` returns the existing constant so a missing or garbled file never breaks a turn.

**Tech Stack:** TypeScript/ESM, Node.js `readFileSync`, `@mycelium/leash-core` frontmatter parser (`splitFrontmatter`), `node:assert` + `tsx` scripts (repo test idiom), Next.js app-router API route.

## Global Constraints

- **No behavior change** — a normal chat turn with `leash.md` present must produce identical results to today.
- **Fallback-safe** — any failure in `loadMainAgentBase()` returns `{ body: DEFAULT_LEASH_SYSTEM, model: "", name: "Leash" }`; the function never throws.
- **`leash.md` body = `DEFAULT_LEASH_SYSTEM` verbatim** — copy byte-for-byte from `apps/web/lib/leash/tools.ts` lines 40–44; do not rewrite or paraphrase.
- **`getPrompt("system")` user override wins** over the def body — precedence unchanged.
- **No new npm dependencies** — use only what is already in the monorepo.
- **Branch:** `feat/leash-default-agent` off `main`. One commit per task.
- **Type-check:** `npx tsc -p apps/web --noEmit` must not introduce new errors beyond any pre-existing ones.

---

### Task 1: `leash.md` + `loadMainAgentBase()` + tests

**Files:**
- Create: `apps/web/builtin-agents/leash.md`
- Create: `apps/web/lib/leash/main-agent.ts`
- Create: `apps/web/scripts/main-agent.test.ts`

**Interfaces:**
- Produces: `export function loadMainAgentBase(mdPath?: string): MainAgentBase`
- Produces: `export interface MainAgentBase { body: string; model: string; name: string }`

- [ ] **Step 1: Create the branch**

```bash
cd /Volumes/Development/qvac/mycelium
git checkout main && git pull
git checkout -b feat/leash-default-agent
```

- [ ] **Step 2: Write the failing test**

Create `apps/web/scripts/main-agent.test.ts`:

```typescript
/**
 * tsx assertion script (repo idiom). Run: npx tsx apps/web/scripts/main-agent.test.ts
 */
import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadMainAgentBase } from "../lib/leash/main-agent.ts";
import { DEFAULT_LEASH_SYSTEM } from "../lib/leash/tools.ts";

function main() {
  // 1. No-regression: body equals the constant byte-for-byte.
  const base = loadMainAgentBase();
  assert.strictEqual(base.body, DEFAULT_LEASH_SYSTEM, "body must equal DEFAULT_LEASH_SYSTEM");
  assert.strictEqual(base.model, "", "model must be empty string (resolvedChatAlias() fills it at runtime)");
  assert.strictEqual(base.name, "Leash", "name must be Leash");

  // 2. Fallback: missing file returns constants, never throws.
  const missing = loadMainAgentBase("/nonexistent/path/leash.md");
  assert.strictEqual(missing.body, DEFAULT_LEASH_SYSTEM, "missing file → DEFAULT_LEASH_SYSTEM");
  assert.strictEqual(missing.model, "", "missing file → empty model");
  assert.strictEqual(missing.name, "Leash", "missing file → name Leash");

  // 3. Fallback: garbled file (no frontmatter block) returns constants.
  const tmp = mkdtempSync(join(tmpdir(), "leash-test-"));
  const garbled = join(tmp, "leash.md");
  writeFileSync(garbled, "no frontmatter here, just prose");
  const garbledResult = loadMainAgentBase(garbled);
  assert.strictEqual(garbledResult.body, DEFAULT_LEASH_SYSTEM, "garbled file → DEFAULT_LEASH_SYSTEM");
  rmSync(tmp, { recursive: true });

  // 4. Custom path with valid frontmatter is parsed correctly.
  const tmp2 = mkdtempSync(join(tmpdir(), "leash-test-"));
  const custom = join(tmp2, "leash.md");
  writeFileSync(custom, "---\nname: TestAgent\nmodel: test-alias\n---\nCustom body.");
  const customResult = loadMainAgentBase(custom);
  assert.strictEqual(customResult.name, "TestAgent", "custom name is parsed from frontmatter");
  assert.strictEqual(customResult.model, "test-alias", "custom model is parsed from frontmatter");
  assert.strictEqual(customResult.body, "Custom body.", "custom body is trimmed");
  rmSync(tmp2, { recursive: true });

  console.log("main-agent: PASS");
}
main();
```

- [ ] **Step 3: Run the test — verify it fails**

```bash
cd /Volumes/Development/qvac/mycelium
npx tsx apps/web/scripts/main-agent.test.ts
```
Expected: `Error: Cannot find module '../lib/leash/main-agent.ts'` or similar import error.

- [ ] **Step 4: Check the leash-core frontmatter export path**

```bash
node -e "const p = require('/Volumes/Development/qvac/mycelium/packages/leash-core/package.json'); console.log(JSON.stringify(p.exports, null, 2))"
```

Look for `"./frontmatter"` in `exports`. Note whether `splitFrontmatter` is reachable as `@mycelium/leash-core/frontmatter` (preferred) or only via the main export. The result determines the import in Step 6.

- [ ] **Step 5: Verify the exact DEFAULT_LEASH_SYSTEM text**

Read `apps/web/lib/leash/tools.ts` lines 40–44 to get the exact string. It is four JS string literals joined with `+`; the concatenated result is a **single line** with no embedded newlines (just spaces at the join points between the sentences). Confirm with:

```bash
node --input-type=module -e "
import { DEFAULT_LEASH_SYSTEM } from '/Volumes/Development/qvac/mycelium/apps/web/lib/leash/tools.ts';
console.log('length:', DEFAULT_LEASH_SYSTEM.length);
console.log('has newlines:', DEFAULT_LEASH_SYSTEM.includes('\n'));
"
```
Expected: `has newlines: false`.

- [ ] **Step 6: Create `apps/web/builtin-agents/leash.md`**

Create the directory:
```bash
mkdir -p /Volumes/Development/qvac/mycelium/apps/web/builtin-agents
```

Write `apps/web/builtin-agents/leash.md`. The body (everything after the closing `---`) must be the exact `DEFAULT_LEASH_SYSTEM` string as a **single line** — no embedded line breaks. Copy it from `tools.ts` directly; do not paraphrase or reformat across multiple lines.

The file structure:
```
---
name: Leash
description: The default on-device assistant.
model:
builtin: true
---
<exact DEFAULT_LEASH_SYSTEM text, single line>
```

After writing, verify body parity:
```bash
node --input-type=module -e "
import { DEFAULT_LEASH_SYSTEM } from '/Volumes/Development/qvac/mycelium/apps/web/lib/leash/tools.ts';
import { readFileSync } from 'node:fs';
const raw = readFileSync('/Volumes/Development/qvac/mycelium/apps/web/builtin-agents/leash.md', 'utf8');
const body = raw.split(/\n---\n/)[1]?.trim() ?? '';
console.log('match:', body === DEFAULT_LEASH_SYSTEM);
"
```
Expected: `match: true`. If `false`, re-read the file and constant and fix the discrepancy.

- [ ] **Step 7: Create `apps/web/lib/leash/main-agent.ts`**

```typescript
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_LEASH_SYSTEM } from "./tools.ts";

// Use splitFrontmatter from leash-core. If @mycelium/leash-core/frontmatter is not a
// valid subpath export (check package.json exports), fall back to the main entry or
// use the inline implementation below.
import { splitFrontmatter } from "@mycelium/leash-core/frontmatter";

export interface MainAgentBase {
  body: string;
  model: string;
  name: string;
}

const FALLBACK: MainAgentBase = { body: DEFAULT_LEASH_SYSTEM, model: "", name: "Leash" };

const here = dirname(fileURLToPath(import.meta.url));
// apps/web/lib/leash → apps/web/builtin-agents/leash.md
const DEFAULT_LEASH_MD = join(here, "..", "..", "builtin-agents", "leash.md");

/**
 * Load the static base (prompt + model + name) for the main Leash agent from leash.md.
 * Never throws — any failure returns the hardcoded constant fallback.
 * @param mdPath - override the file path (used by tests; omit in production)
 */
export function loadMainAgentBase(mdPath?: string): MainAgentBase {
  try {
    const raw = readFileSync(mdPath ?? DEFAULT_LEASH_MD, "utf8");
    const parsed = splitFrontmatter(raw);
    if (!parsed) return FALLBACK;
    const { fields, body } = parsed;
    const trimmedBody = body.trim();
    return {
      body: trimmedBody || FALLBACK.body,
      model: (fields["model"] ?? "").trim(),
      name: (fields["name"] ?? "").trim() || FALLBACK.name,
    };
  } catch {
    return FALLBACK;
  }
}
```

**If `@mycelium/leash-core/frontmatter` is not a valid subpath** (not listed in leash-core's `exports`), replace the import with this inline minimal parser — identical semantics, zero new deps:

```typescript
function splitFrontmatter(raw: string): { fields: Record<string, string>; body: string } | null {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const fields: Record<string, string> = {};
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    fields[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { fields, body: m[2] ?? "" };
}
```

- [ ] **Step 8: Run the test — verify it passes**

```bash
npx tsx apps/web/scripts/main-agent.test.ts
```
Expected: `main-agent: PASS`

If test 1 fails with `body` mismatch: the text in `leash.md` diverged from the constant. Re-check Step 6 (body must be a single line, byte-for-byte copy of the concatenated `DEFAULT_LEASH_SYSTEM`).

- [ ] **Step 9: Commit**

```bash
git add apps/web/builtin-agents/leash.md apps/web/lib/leash/main-agent.ts apps/web/scripts/main-agent.test.ts
git commit -m "feat: add leash.md agent def and loadMainAgentBase()"
```

---

### Task 2: Add optional fallback to `getPrompt`

**Files:**
- Modify: `apps/web/lib/leash/prompts-store.ts`

**Interfaces:**
- Consumes: nothing new (additive signature change only)
- Produces: `getPrompt(key: PromptKey, fallback?: string): Promise<string>` — when `fallback` is provided and no user override exists, returns `fallback` instead of `DEFAULTS[key]`

- [ ] **Step 1: Read the current function**

Read `apps/web/lib/leash/prompts-store.ts` and locate the `getPrompt` export. It currently matches:
```typescript
export async function getPrompt(key: PromptKey): Promise<string> {
  const o = (await loadOverrides())[key];
  return typeof o === "string" && o.trim() ? o : DEFAULTS[key];
}
```

- [ ] **Step 2: Add the optional `fallback` parameter**

Change the function signature and return expression:
```typescript
export async function getPrompt(key: PromptKey, fallback?: string): Promise<string> {
  const o = (await loadOverrides())[key];
  return typeof o === "string" && o.trim() ? o : (fallback ?? DEFAULTS[key]);
}
```

That is the complete diff. All existing callers pass no second argument; `fallback ?? DEFAULTS[key]` equals `DEFAULTS[key]` when `fallback` is `undefined`, so every existing call is unchanged.

- [ ] **Step 3: Type-check**

```bash
npx tsc -p apps/web --noEmit 2>&1 | head -40
```
Expected: no new errors attributed to `prompts-store.ts`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/leash/prompts-store.ts
git commit -m "feat: add optional fallback param to getPrompt"
```

---

### Task 3: Wire the route — source base from `loadMainAgentBase()`

**Files:**
- Modify: `apps/web/app/api/leash/chat/route.ts`

**Interfaces:**
- Consumes: `loadMainAgentBase(): MainAgentBase` (Task 1)
- Consumes: `getPrompt(key, fallback?)` (Task 2)

- [ ] **Step 1: Read the current route**

Read `apps/web/app/api/leash/chat/route.ts`. Locate three things:
1. The import block at the top — find where `leash/tools.ts` or `leash/prompts-store.ts` are imported.
2. The model selection line (~line 308): `const defaultAlias = chosenModel ?? resolvedChatAlias();`
3. The `Promise.all` that includes `getPrompt("system")` (~line 375).

- [ ] **Step 2: Add the import**

In the import block at the top of `route.ts`, add:
```typescript
import { loadMainAgentBase } from "../../../../lib/leash/main-agent.ts";
```
Place it near the other `lib/leash/*` imports (e.g. after the `prompts-store.ts` import line).

- [ ] **Step 3: Call `loadMainAgentBase()` before the model/prompt block**

Inside the handler function, add this line **before** the `Promise.all` that calls `getPrompt("system")` and **before** the model selection line. A good placement is near the start of the handler body where other synchronous setup happens:
```typescript
const base = loadMainAgentBase();
```
It is synchronous — no `await`.

- [ ] **Step 4: Wire the default model**

Find (~line 308):
```typescript
const defaultAlias = chosenModel ?? resolvedChatAlias();
```
Change to:
```typescript
const defaultAlias = chosenModel ?? (base.model || resolvedChatAlias());
```
Since `leash.md` has an empty `model:` field, `base.model` is `""` today and `"" || resolvedChatAlias()` equals `resolvedChatAlias()` — behavior is identical. This line becomes the Phase B lever when `leash.md`'s `model:` field is populated.

- [ ] **Step 5: Wire the system prompt fallback**

Find the `Promise.all` line (~line 375) that contains `getPrompt("system")`:
```typescript
const [systemPrompt, skillsSection, activeSkills, prefs, constitution] = await Promise.all([getPrompt("system"), skillsSystemSection(), ...rest...]);
```
Change `getPrompt("system")` to `getPrompt("system", base.body)`:
```typescript
const [systemPrompt, skillsSection, activeSkills, prefs, constitution] = await Promise.all([getPrompt("system", base.body), skillsSystemSection(), ...rest...]);
```
Only the first argument to `Promise.all` changes. All other elements stay exactly as they are.

Effect: if the user has set a `system` override in `data/leash-prompts.json`, `systemPrompt` equals the override (unchanged). If no override exists, `systemPrompt` equals `base.body` (which is `DEFAULT_LEASH_SYSTEM` today — identical to the current fallback). No behavioral change.

- [ ] **Step 6: Type-check the full web app**

```bash
npx tsc -p apps/web --noEmit 2>&1 | head -60
```
Expected: no new errors. Any pre-existing errors are acceptable; new errors in `route.ts`, `main-agent.ts`, or `prompts-store.ts` must be fixed before proceeding.

- [ ] **Step 7: Run all tests**

```bash
npx tsx apps/web/scripts/main-agent.test.ts
npx tsx apps/web/scripts/conductor.test.ts
```
Expected: both print `PASS`.

- [ ] **Step 8: Commit**

```bash
git add apps/web/app/api/leash/chat/route.ts
git commit -m "feat: wire chat route to load base from leash.md agent def"
```

---

## Verification

**Automated (run after all three tasks):**
```bash
cd /Volumes/Development/qvac/mycelium
npx tsx apps/web/scripts/main-agent.test.ts    # → main-agent: PASS
npx tsx apps/web/scripts/conductor.test.ts     # → conductor: PASS
npx tsc -p apps/web --noEmit 2>&1 | grep "error TS" | wc -l  # → same count as before
```

**Fallback regression check:**
```bash
mv apps/web/builtin-agents/leash.md apps/web/builtin-agents/leash.md.bak
npx tsx apps/web/scripts/main-agent.test.ts   # tests 2 and 3 already cover this path
mv apps/web/builtin-agents/leash.md.bak apps/web/builtin-agents/leash.md
```

**Manual end-to-end (dev server):**
```bash
npm run dev   # from mycelium/
```
Send a normal chat message. Verify:
1. Reply shape is identical to before.
2. No console errors mentioning `leash.md` or `main-agent`.
3. The `systemPrompt` fed to the model (visible in server logs if debug logging is on) matches `DEFAULT_LEASH_SYSTEM`.

**User override precedence check:**
- Temporarily set a custom `system` key in `data/leash-prompts.json`
- Send a turn; verify the override text appears in the system prompt (not `base.body`)
- Remove the override; verify the base text is restored
