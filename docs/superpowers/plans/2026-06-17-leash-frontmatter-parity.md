# Phase C: Full Claude-Standard Agent Frontmatter Parity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the `Agent` definition to full parity with the Claude Code sub-agent frontmatter standard — implement `mcpServers` (reference + inline) and `memory` (user-scope persistent dir), and reserve `permissionMode`/`hooks`/`background`/`effort`/`isolation`/`color`/`initialPrompt` (parsed, stored, surfaced, not wired).

**Architecture:** Extend the leash-core `Agent` model + flat frontmatter parser (camelCase and kebab accepted; nested fields via JSON block scalar; reserved fields stored raw). Wire `mcpServers` and `memory` into the delegate runtime (`agent-runner.ts`): references grant an already-connected server's tool-names; inline defs connect-on-start / disconnect-on-finish; `memory` injects the agent's `MEMORY.md` and grants a sandboxed agent-memory toolset. Surface all fields in the dashboard.

**Tech Stack:** TypeScript/ESM, `@mycelium/leash-core` (built to `dist/`, consumed by the web app), Vercel AI SDK `tool()`/`ToolLoopAgent`, `@ai-sdk/mcp`, `node:assert` + `tsx` test scripts.

## Global Constraints

- **The standard is https://code.claude.com/docs/en/sub-agents** (the "Supported frontmatter fields" table). Match it; adapt only where on-device forces it.
- **`model` is a QVAC served alias ONLY** (Hard Rule 1) — never `sonnet`/`opus`/`haiku`/`fable`/cloud IDs. Claude's `inherit`/omitted ⇒ our empty-default (unchanged).
- **`mcpServers` = both forms:** a string reference to an already-configured server (shares the global connection) OR an inline def (`stdio`/`http`/`sse`, same schema as `.mcp.json`) connected when the delegate starts, disconnected when it finishes.
- **`memory` = scope enum (`user`/`project`/`local`)**, NOT a boolean, NOT the existing remember/recall. Implement **`user`** → `<dataDir>/agent-memory/<slug>/`; `project`/`local` parse but fall back to the `user` dir.
- **Plugin agents (`source:"plugin"`) IGNORE `mcpServers`/`permissionMode`/`hooks`** (security parity with the doc).
- **Wiring is delegate-only.** The main Leash turn keeps its current access; agent-as-main stays the latent future.
- **Frontmatter keys are lowercased by `parseFrontmatter`** — so `mcpServers`→`mcpservers`, `disallowedTools`→`disallowedtools`, `maxTurns`→`maxturns`, `permissionMode`→`permissionmode`, `initialPrompt`→`initialprompt`. Read the lowercased key AND the kebab variant.
- **leash-core is consumed as built `dist/`** — after editing `packages/leash-core/src/*` run `npx tsc -b packages/leash-core` before tests / `tsc -p apps/web` / the app. The rebuilt `dist/` is gitignored — never commit it.
- **Known pre-existing tsc errors** (NOT yours): `apps/web/lib/leash/provider.ts` (TS2724) and `apps/web/scripts/verify-data-dir-env.ts` (TS2345). Only these two are acceptable.
- **Branch:** `feat/leash-frontmatter-parity` (already created; spec is its first commit). One commit per task. Test idiom: `npx tsx <script>.test.ts` → prints `<name>: PASS`.

---

### Task 1: Extend the `Agent` model + parser (leash-core)

**Files:**
- Modify: `packages/leash-core/src/agents-store.ts` (interface, parse helpers, `buildAgent`, `saveAgent`, `serializeAgent`)
- Test: `apps/web/scripts/agent-frontmatter.test.ts`

**Interfaces:**
- Consumes: `validateServerInput`, `NormalizedServer` from `./mcp-config.ts`; existing `splitFrontmatter`, `parseToolList`.
- Produces: `Agent` gains `mcpServers: AgentMcpServers`, `memory: MemoryScope`, `permissionMode/hooks/effort/isolation/color/initialPrompt: string`, `background: boolean`; exported `AgentMcpServers`, `MemoryScope`, `parseAgentMcpServers`, `parseMemoryScope`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/scripts/agent-frontmatter.test.ts`:

```typescript
/** tsx assertion script. Run: npx tsx apps/web/scripts/agent-frontmatter.test.ts */
import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "agent-fm-"));
  process.env["LEASH_AGENTS_DIR"] = dir;
  const store = await import("@mycelium/leash-core/agents-store");
  const { getUserAgent, parseAgentMcpServers, parseMemoryScope } = store;

  // 1. mcpServers: empty-object value = reference; populated = inline (validated)
  const m = parseAgentMcpServers('{ "github": {}, "playwright": { "transport": "stdio", "command": "npx", "args": ["-y","@playwright/mcp"] } }');
  assert.deepStrictEqual(m.refs, ["github"], "empty value ⇒ reference");
  assert.strictEqual(m.inline.length, 1, "populated value ⇒ inline");
  assert.strictEqual(m.inline[0]!.name, "playwright", "inline name");
  assert.strictEqual(m.inline[0]!.command, "npx", "inline command validated");

  // 2. malformed mcpServers ⇒ empty, never throws
  assert.deepStrictEqual(parseAgentMcpServers("not json"), { refs: [], inline: [] }, "bad json ⇒ empty");

  // 3. memory scope
  assert.strictEqual(parseMemoryScope("user"), "user");
  assert.strictEqual(parseMemoryScope("PROJECT"), "project");
  assert.strictEqual(parseMemoryScope("bogus"), "", "junk ⇒ empty");

  // 4. camelCase AND kebab both parse; reserved fields stored raw; model never coerces
  writeFileSync(join(dir, "full.md"),
    "---\nname: Full\ndescription: d\n" +
    "disallowedTools: a, b\nmaxTurns: 9\n" +
    "permissionMode: dontAsk\ncolor: blue\nbackground: true\neffort: high\nisolation: worktree\ninitialPrompt: hi\n" +
    "memory: user\n" +
    "mcpServers: |\n  { \"github\": {} }\n---\nbody");
  const a = (await getUserAgent("full"))!;
  assert.deepStrictEqual(a.disallowedTools, ["a", "b"], "camelCase disallowedTools");
  assert.strictEqual(a.maxTurns, 9, "camelCase maxTurns");
  assert.strictEqual(a.permissionMode, "dontAsk", "reserved permissionMode stored");
  assert.strictEqual(a.color, "blue", "reserved color stored");
  assert.strictEqual(a.background, true, "reserved background bool");
  assert.strictEqual(a.effort, "high", "reserved effort stored");
  assert.strictEqual(a.isolation, "worktree", "reserved isolation stored");
  assert.strictEqual(a.initialPrompt, "hi", "reserved initialPrompt stored");
  assert.strictEqual(a.memory, "user", "memory scope");
  assert.deepStrictEqual(a.mcpServers.refs, ["github"], "mcpServers ref via block scalar");

  // 5. invalid reserved enum ⇒ empty (inert)
  writeFileSync(join(dir, "bad.md"), "---\nname: Bad\ndescription: d\npermissionMode: nonsense\ncolor: chartreuse\n---\nx");
  const b = (await getUserAgent("bad"))!;
  assert.strictEqual(b.permissionMode, "", "invalid permissionMode ⇒ empty");
  assert.strictEqual(b.color, "", "invalid color ⇒ empty");

  rmSync(dir, { recursive: true });
  console.log("agent-frontmatter: PASS");
}
main();
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `cd /Volumes/Development/qvac/mycelium && npx tsx apps/web/scripts/agent-frontmatter.test.ts`
Expected: FAIL — `parseAgentMcpServers` is not exported / fields missing.

- [ ] **Step 3: Add types + parse helpers to `agents-store.ts`**

Add the import at the top (near the other `./` imports):
```typescript
import { validateServerInput, type NormalizedServer } from "./mcp-config.ts";
```

Add exported types + helpers (place them above `buildAgent`):
```typescript
export type MemoryScope = "" | "user" | "project" | "local";
/** Per-agent MCP: string references (share the global connection) + inline defs (connected for the agent's run). */
export interface AgentMcpServers {
  refs: string[];
  inline: NormalizedServer[];
}
const PERMISSION_MODES = new Set(["default", "acceptEdits", "auto", "dontAsk", "bypassPermissions", "plan"]);
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
const COLORS = new Set(["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"]);

/** `memory:` scope — Claude's user/project/local; anything else ⇒ "" (off). */
export function parseMemoryScope(raw: string | undefined): MemoryScope {
  const s = (raw ?? "").trim().toLowerCase();
  return s === "user" || s === "project" || s === "local" ? s : "";
}

/**
 * Parse `mcpServers:` — a JSON object `{ "<name>": {} | <serverConfig> }` (authored as a block scalar).
 * Empty/`{}` value ⇒ a REFERENCE to an already-configured server; a populated object ⇒ an INLINE def
 * validated through the shared `validateServerInput`. Malformed entries are skipped; never throws.
 */
export function parseAgentMcpServers(raw: string | undefined): AgentMcpServers {
  const out: AgentMcpServers = { refs: [], inline: [] };
  if (!raw?.trim()) return out;
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return out; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;
  for (const [rawName, val] of Object.entries(obj as Record<string, unknown>)) {
    const name = rawName.trim();
    if (!name) continue;
    const isEmpty = !val || (typeof val === "object" && !Array.isArray(val) && Object.keys(val as object).length === 0);
    if (isEmpty) { out.refs.push(name); continue; }
    if (typeof val === "object" && !Array.isArray(val)) {
      try { out.inline.push(validateServerInput({ name, ...(val as Record<string, unknown>) })); } catch { /* skip malformed */ }
    }
  }
  return out;
}

/** A reserved enum field: keep the raw value only if it's in the allowed set, else "" (parsed-but-inert). */
function parseEnumField(raw: string | undefined, allowed: ReadonlySet<string>): string {
  const v = (raw ?? "").trim();
  return allowed.has(v) ? v : "";
}
```

- [ ] **Step 4: Add the fields to the `Agent` interface**

After the `builtin: boolean;` line in `interface Agent`, add:
```typescript
  /** Per-agent MCP servers (frontmatter `mcpServers:`) — references + inline defs. Stripped for plugin agents. */
  mcpServers: AgentMcpServers;
  /** Persistent-memory scope (frontmatter `memory:`): "" | user | project | local. */
  memory: MemoryScope;
  /** RESERVED (parsed/stored/surfaced, not yet wired). Stripped for plugin agents. */
  permissionMode: string;
  /** RESERVED — raw frontmatter value (not yet wired). Stripped for plugin agents. */
  hooks: string;
  /** RESERVED — run-as-background flag (not yet wired). */
  background: boolean;
  /** RESERVED — effort level (not yet wired). */
  effort: string;
  /** RESERVED — worktree isolation (N/A on-device; not wired). */
  isolation: string;
  /** RESERVED — UI display color (not yet wired). */
  color: string;
  /** RESERVED — auto-submitted first turn for agent-as-main (not yet wired). */
  initialPrompt: string;
```

- [ ] **Step 5: Parse the fields in `buildAgent` (with plugin stripping)**

In `buildAgent`, after `builtin: fields["builtin"] === "true",` add:
```typescript
    // RESERVED — parsed/stored/surfaced, not yet wired.
    permissionMode: source === "plugin" ? "" : parseEnumField(fields["permissionmode"] ?? fields["permission-mode"], PERMISSION_MODES),
    hooks: source === "plugin" ? "" : (fields["hooks"] ?? "").trim(),
    background: (fields["background"] ?? "").trim() === "true",
    effort: parseEnumField(fields["effort"], EFFORT_LEVELS),
    isolation: (fields["isolation"] ?? "").trim(),
    color: parseEnumField(fields["color"], COLORS),
    initialPrompt: (fields["initialprompt"] ?? fields["initial-prompt"] ?? "").trim(),
    // ACTIVE (wired in later tasks). Plugin agents: mcpServers stripped (security parity with Claude).
    mcpServers: source === "plugin" ? { refs: [], inline: [] } : parseAgentMcpServers(fields["mcpservers"] ?? fields["mcp-servers"]),
    memory: parseMemoryScope(fields["memory"]),
```

- [ ] **Step 6: Thread the fields through `saveAgent` + `serializeAgent`**

In `saveAgent`'s input type, after `builtin?: boolean;` add:
```typescript
    mcpServers?: AgentMcpServers;
    memory?: MemoryScope;
    permissionMode?: string;
    hooks?: string;
    background?: boolean;
    effort?: string;
    isolation?: string;
    color?: string;
    initialPrompt?: string;
```
In the `a` object built inside `saveAgent` (after `builtin: input.builtin ?? false,`) add:
```typescript
    mcpServers: input.mcpServers ?? { refs: [], inline: [] },
    memory: input.memory ?? "",
    permissionMode: input.permissionMode ?? "",
    hooks: input.hooks ?? "",
    background: input.background ?? false,
    effort: input.effort ?? "",
    isolation: input.isolation ?? "",
    color: input.color ?? "",
    initialPrompt: input.initialPrompt ?? "",
```
Widen `serializeAgent`'s `Pick<Agent, ...>` to include the new fields, and after the `max-turns:` line append:
```typescript
  if (a.memory) fm += `memory: ${a.memory}\n`;
  if (a.permissionMode) fm += `permissionMode: ${a.permissionMode}\n`;
  if (a.background) fm += `background: true\n`;
  if (a.effort) fm += `effort: ${a.effort}\n`;
  if (a.isolation) fm += `isolation: ${a.isolation}\n`;
  if (a.color) fm += `color: ${a.color}\n`;
  if (a.initialPrompt) fm += `initialPrompt: ${oneLine(a.initialPrompt)}\n`;
  if (a.hooks) fm += `hooks: ${a.hooks}\n`;
  const refs = a.mcpServers?.refs ?? [], inline = a.mcpServers?.inline ?? [];
  if (refs.length || inline.length) {
    const obj: Record<string, unknown> = {};
    for (const r of refs) obj[r] = {};
    for (const s of inline) { const { name, ...rest } = s; obj[name] = rest; }
    fm += `mcpServers: |\n  ${JSON.stringify(obj)}\n`;
  }
```

- [ ] **Step 7: Rebuild leash-core, run the test**

```bash
cd /Volumes/Development/qvac/mycelium && npx tsc -b packages/leash-core
npx tsx apps/web/scripts/agent-frontmatter.test.ts
```
Expected: leash-core builds clean (fix any incomplete `Agent` literal it surfaces — e.g. `plugins-store.ts` spread already carries the new fields since they come from `buildAgent`; if a literal elsewhere errors, add the new fields with empty defaults). Test prints `agent-frontmatter: PASS`.

- [ ] **Step 8: Type-check the web app**

Run: `npx tsc -p apps/web --noEmit 2>&1 | grep "error TS"`
Expected: only the 2 known pre-existing errors. (The client `Agent` type in `AgentsPanel.tsx` is a local mirror, not the leash-core type, so it won't error yet — it's updated in Task 5.)

- [ ] **Step 9: Commit**

```bash
git add packages/leash-core/src/agents-store.ts apps/web/scripts/agent-frontmatter.test.ts
git commit -m "feat(agents): parse full Claude frontmatter set (mcpServers/memory + reserved fields)"
```

---

### Task 2: Wire `mcpServers` references into delegation

**Files:**
- Create: `apps/web/lib/leash/agent-grants.ts` (pure helper — NO `server-only`, so the tsx test can import it)
- Modify: `apps/web/lib/leash/mcp.ts` (add `mcpToolNamesForServers`)
- Modify: `apps/web/lib/leash/agent-runner.ts` (`agentTools` grants referenced servers' tools)
- Test: `apps/web/scripts/agent-mcp-refs.test.ts`

**Interfaces:**
- Consumes: `Agent.mcpServers` (Task 1).
- Produces: `grantedNames(...)` (agent-grants.ts); `mcpToolNamesForServers(names: string[]): Promise<string[]>` (mcp.ts).

**Why a separate `agent-grants.ts`:** `agent-runner.ts` starts with `import "server-only"`, which throws under `tsx` — so a test cannot import from it. The pure `grantedNames` logic lives in its own guard-free module (`mcp.ts`'s `mcpToolNamesForServers` stays server-only and is covered by Task 6's manual e2e, not a unit test).

- [ ] **Step 1: Write the failing test**

Create `apps/web/scripts/agent-mcp-refs.test.ts` — a pure test of the grant logic (the helper that expands the allow-set), avoiding live MCP:

```typescript
/** tsx assertion script. Run: npx tsx apps/web/scripts/agent-mcp-refs.test.ts */
import assert from "node:assert";
import { grantedNames } from "../lib/leash/agent-grants.ts";

function main() {
  // grantedNames(serverToolNames, registryKeys, alreadyChosen, denied) → names to ADD
  const registry = new Set(["gh_pr", "gh_issue", "other"]);
  const out = grantedNames(["gh_pr", "gh_issue", "missing"], registry, new Set(["gh_pr"]), new Set(["gh_issue"]));
  assert.deepStrictEqual(out, [], "gh_pr already chosen, gh_issue denied, missing not in registry ⇒ none");
  const out2 = grantedNames(["gh_pr", "gh_issue"], registry, new Set(), new Set());
  assert.deepStrictEqual(out2.sort(), ["gh_issue", "gh_pr"], "both granted when in registry, not chosen, not denied");
  console.log("agent-mcp-refs: PASS");
}
main();
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npx tsx apps/web/scripts/agent-mcp-refs.test.ts`
Expected: FAIL — `grantedNames` not exported.

- [ ] **Step 3a: Create the pure `agent-grants.ts` (no `server-only`)**

Create `apps/web/lib/leash/agent-grants.ts`:
```typescript
// No 'server-only' guard: pure logic imported by scripts/agent-mcp-refs.test.ts (tsx, outside Next.js).
/** Which referenced-server tool names to ADD to a delegate's allow-set (in registry, not already chosen, not denied). */
export function grantedNames(serverToolNames: string[], registryKeys: Set<string>, chosen: Set<string>, denied: Set<string>): string[] {
  const out: string[] = [];
  for (const n of serverToolNames) {
    if (registryKeys.has(n) && !chosen.has(n) && !denied.has(n) && !out.includes(n)) out.push(n);
  }
  return out;
}
```

- [ ] **Step 3b: Add `mcpToolNamesForServers` to `mcp.ts`**

Near `leashMcpTools()` (the connection registry is in-module), add:
```typescript
/** Tool names belonging to the given MCP server NAMES (already-connected servers only). */
export async function mcpToolNamesForServers(names: string[]): Promise<string[]> {
  if (!names.length) return [];
  await reconcile();
  const want = new Set(names.map((n) => n.trim().toLowerCase()));
  const out: string[] = [];
  for (const conn of registry.connections.values()) {
    if (want.has(conn.entry.name.trim().toLowerCase())) out.push(...conn.toolNames);
  }
  return out;
}
```

- [ ] **Step 4: Wire reference-granting into `agent-runner.ts`**

Add the imports:
```typescript
import { mcpToolNamesForServers } from "./mcp.ts";
import { grantedNames } from "./agent-grants.ts";
```
In `agentTools`, after the existing `for (const n of agent.tools)` loop and before building `tools`, add reference granting:
```typescript
  if (agent.mcpServers.refs.length) {
    const serverToolNames = await mcpToolNamesForServers(agent.mcpServers.refs);
    const chosen = new Set(names);
    for (const n of grantedNames(serverToolNames, new Set(Object.keys(registry)), chosen, denied)) {
      if (await toolNeedsApproval(n)) continue; // delegates still can't use approval-gated tools
      names.push(n);
    }
  }
```
(The referenced server's tools are already in `registry` because the chat route's `baseTools` merged `leashMcpTools()`; granting just expands the allow-set.)

- [ ] **Step 5: Run the test — verify it passes**

Run: `npx tsx apps/web/scripts/agent-mcp-refs.test.ts`
Expected: `agent-mcp-refs: PASS`

- [ ] **Step 6: Type-check + commit**

```bash
npx tsc -p apps/web --noEmit 2>&1 | grep "error TS"   # only the 2 known
git add apps/web/lib/leash/mcp.ts apps/web/lib/leash/agent-runner.ts apps/web/scripts/agent-mcp-refs.test.ts
git commit -m "feat(agents): grant referenced mcpServers' tools to delegates"
```

---

### Task 3: Wire `mcpServers` inline (connect-on-start / disconnect-on-finish)

**Files:**
- Modify: `apps/web/lib/leash/mcp.ts` (add `connectInline`)
- Modify: `apps/web/lib/leash/agent-runner.ts` (`buildOne` connects inline, merges tools, disconnects in `finally`)

**Interfaces:**
- Consumes: `Agent.mcpServers.inline` (Task 1), `NormalizedServer`.
- Produces: `connectInline(defs: NormalizedServer[]): Promise<{ tools: ToolSet; close: () => Promise<void> }>` (mcp.ts).

**Note:** This connects real MCP servers, so it has no pure unit test; verification is `tsc` + Task 6's manual e2e. Connections are transient and isolated from the global registry (the doc: "scoped to this subagent only; the parent conversation does not get the tools").

- [ ] **Step 1: Add `connectInline` to `mcp.ts`**

Mirror the existing `connectOne` connection core (which builds a client via `transportFor`/`createMCPClient` and discovers tools via `client.tools()`), but return a handle instead of storing in the global `registry`. Add:
```typescript
/**
 * Connect inline (per-delegate) MCP servers WITHOUT touching the global registry — the parent
 * conversation never sees their tools (per the Claude sub-agent spec). Returns the merged tools and a
 * `close()` that disconnects every client. Failures are logged and skipped (that server is simply absent).
 */
export async function connectInline(defs: NormalizedServer[]): Promise<{ tools: ToolSet; close: () => Promise<void> }> {
  const clients: MCPClient[] = [];
  let tools: ToolSet = {};
  for (const def of defs) {
    try {
      const entry = { ...def, id: `inline:${def.name}`, enabled: true } as McpServerEntry;
      const client = await createMCPClient({ transport: transportFor(entry) as Parameters<typeof createMCPClient>[0]["transport"] });
      const t = (await client.tools()) as ToolSet;
      clients.push(client);
      tools = { ...tools, ...t };
    } catch (err) {
      console.warn(`leash mcp: inline server "${def.name}" failed:`, err instanceof Error ? err.message : err);
    }
  }
  return {
    tools,
    close: async () => { for (const c of clients) { try { await c.close(); } catch { /* already gone */ } } },
  };
}
```
(Reuse the file's existing `transportFor`, `createMCPClient`, `MCPClient`, `McpServerEntry`, `ToolSet` imports. Match `connectOne`'s exact client-creation call shape — read lines ~162-205 and mirror them, including any timeout wrapper it uses.)

- [ ] **Step 2: Wire inline connect/disconnect into `buildOne`**

Add the import:
```typescript
import { connectInline } from "./mcp.ts";
```
In `buildOne`'s `execute` generator, wrap the sub-agent run so inline servers connect first and always disconnect. Replace the body that builds `tools`/runs the agent with:
```typescript
        const { tools, names } = await agentTools(agent, registry);
        const skillCtx = await preloadSkills(agent);
        const inline = agent.mcpServers.inline.length ? await connectInline(agent.mcpServers.inline) : { tools: {}, close: async () => {} };
        try {
          const merged: ToolSet = { ...(names.length ? tools : {}), ...inline.tools };
          const runTools = Object.keys(merged).length ? merged : KEEPALIVE_TOOLS;
          loopLog(`agent ${agent.slug}: ${task.slice(0, 60)} (${Object.keys(runTools).length} tool(s), ${agent.skills.length} skill(s), ${agent.mcpServers.inline.length} inline mcp)`);
          const sub = new ToolLoopAgent({
            model: chatModel(`agent:${agent.slug}`, agent.model || undefined),
            instructions: (agent.body || `You are the "${agent.name}" agent. Carry out the task and end with a clear, self-contained summary of your result.`) + skillCtx,
            temperature: 0.6,
            topP: 0.95,
            maxRetries: 0,
            tools: runTools,
            stopWhen: stepCountIs(agent.maxTurns),
          });
          const result = await sub.stream({ prompt: task });
          for await (const message of readUIMessageStream({ stream: result.toUIMessageStream() })) {
            yield message;
          }
        } catch (e) {
          yield { id: `agent-err-${agent.slug}`, role: "assistant", parts: [{ type: "text", text: `The "${agent.slug}" agent failed: ${e instanceof Error ? e.message : String(e)}` }] } as UIMessage;
        } finally {
          await inline.close();
        }
```
(This preserves the existing keep-alive-when-toolless guard and the error-as-UIMessage path, and guarantees `inline.close()` runs even on error.)

- [ ] **Step 3: Type-check + commit**

```bash
npx tsc -p apps/web --noEmit 2>&1 | grep "error TS"   # only the 2 known
git add apps/web/lib/leash/mcp.ts apps/web/lib/leash/agent-runner.ts
git commit -m "feat(agents): connect inline mcpServers per-delegate (disconnect on finish)"
```

---

### Task 4: Wire `memory` (sandboxed per-agent persistent dir)

**Files:**
- Create: `apps/web/lib/leash/agent-memory.ts`
- Modify: `apps/web/lib/leash/agent-runner.ts` (`buildOne` injects memory context + tools)
- Test: `apps/web/scripts/agent-memory.test.ts`

**Interfaces:**
- Consumes: `Agent.memory` (Task 1).
- Produces: `memoryDir(slug)`, `readMemoryContext(slug): Promise<string>`, `agentMemoryTools(slug): ToolSet` (agent-memory.ts).

- [ ] **Step 1: Write the failing test**

Create `apps/web/scripts/agent-memory.test.ts`:

```typescript
/** tsx assertion script. Run: npx tsx apps/web/scripts/agent-memory.test.ts */
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function main() {
  const base = mkdtempSync(join(tmpdir(), "agent-mem-"));
  process.env["LEASH_AGENT_MEMORY_DIR"] = base;
  const { memoryDir, readMemoryContext, agentMemoryTools } = await import("../lib/leash/agent-memory.ts");

  // 1. dir path
  assert.strictEqual(memoryDir("coder"), join(base, "coder"), "memoryDir path");

  // 2. readMemoryContext: empty when absent, content + cap when present
  assert.strictEqual(await readMemoryContext("nope"), "", "absent ⇒ empty");
  mkdirSync(join(base, "coder"), { recursive: true });
  writeFileSync(join(base, "coder", "MEMORY.md"), "line1\nline2\n");
  const ctx = await readMemoryContext("coder");
  assert.ok(ctx.includes("line1") && ctx.includes("line2"), "context includes MEMORY.md");
  assert.ok(/persistent memory/i.test(ctx), "context is wrapped/labelled");

  // 3. tools: write within dir works; path traversal rejected
  const tools = agentMemoryTools("coder") as Record<string, { execute: (a: any) => Promise<any> }>;
  await tools["write_memory"]!.execute({ file: "MEMORY.md", content: "hello" });
  assert.strictEqual(readFileSync(join(base, "coder", "MEMORY.md"), "utf8"), "hello", "write within dir");
  const bad = await tools["write_memory"]!.execute({ file: "../escape.txt", content: "x" });
  assert.ok(/refus|outside|invalid/i.test(JSON.stringify(bad)), "traversal rejected");
  const readBack = await tools["read_memory"]!.execute({ file: "MEMORY.md" });
  assert.ok(JSON.stringify(readBack).includes("hello"), "read within dir");

  rmSync(base, { recursive: true });
  console.log("agent-memory: PASS");
}
main();
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npx tsx apps/web/scripts/agent-memory.test.ts`
Expected: FAIL — module/exports missing.

- [ ] **Step 3: Create `apps/web/lib/leash/agent-memory.ts`**

```typescript
/**
 * Per-agent persistent memory (Claude sub-agent `memory:` field, `user` scope). Each memory-enabled
 * agent gets a sandboxed directory <dataDir>/agent-memory/<slug>/ with a MEMORY.md it curates across
 * runs. Tools are JAILED to that directory (no traversal) and are NOT approval-gated (safe by sandbox),
 * so delegates can use them. Mirrors Claude's "Read/Write/Edit auto-enabled on the memory dir."
 *
 * No 'server-only' guard: imported by scripts/agent-memory.test.ts (tsx, outside Next.js). It only
 * does read-only/jailed fs access within the agent's own memory directory.
 */
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { DATA_DIR } from "@mycelium/leash-core/json-store";

const BASE = process.env["LEASH_AGENT_MEMORY_DIR"] ?? join(DATA_DIR, "agent-memory");
const MAX_LINES = 200, MAX_BYTES = 25_000;

export function memoryDir(slug: string): string {
  return join(BASE, slug);
}

/** Resolve a relative file inside the agent's dir, rejecting traversal. Returns null if it escapes. */
function jail(slug: string, file: string): string | null {
  const dir = resolve(memoryDir(slug));
  const target = resolve(join(dir, file || "MEMORY.md"));
  return target === dir || target.startsWith(dir + sep) ? target : null;
}

/** The first MAX_LINES / MAX_BYTES of MEMORY.md, wrapped for injection. "" if absent. */
export async function readMemoryContext(slug: string): Promise<string> {
  try {
    let raw = await readFile(join(memoryDir(slug), "MEMORY.md"), "utf8");
    if (Buffer.byteLength(raw) > MAX_BYTES) raw = Buffer.from(raw).subarray(0, MAX_BYTES).toString("utf8");
    raw = raw.split(/\r?\n/).slice(0, MAX_LINES).join("\n");
    return raw.trim() ? `\n\n--- Your persistent memory (read it, and keep MEMORY.md current as you learn) ---\n${raw.trim()}` : "";
  } catch {
    return "";
  }
}

/** Sandboxed read/append/write tools scoped to the agent's memory dir. Auto-granted when `memory:` is set. */
export function agentMemoryTools(slug: string): ToolSet {
  const guard = async (file: string): Promise<string | null> => {
    const p = jail(slug, file);
    if (p) await mkdir(memoryDir(slug), { recursive: true });
    return p;
  };
  return {
    read_memory: tool({
      description: "Read one of your persistent memory files (default MEMORY.md). Your knowledge that survives across runs.",
      inputSchema: z.object({ file: z.string().optional().describe("Relative filename inside your memory dir; default MEMORY.md") }),
      execute: async ({ file }) => {
        const p = await guard(file ?? "MEMORY.md");
        if (!p) return { text: "Refused: path outside your memory directory." };
        try { return { text: await readFile(p, "utf8") }; } catch { return { text: "(empty)" }; }
      },
    }),
    write_memory: tool({
      description: "Overwrite one of your persistent memory files (default MEMORY.md) with new content.",
      inputSchema: z.object({ file: z.string().optional(), content: z.string() }),
      execute: async ({ file, content }) => {
        const p = await guard(file ?? "MEMORY.md");
        if (!p) return { text: "Refused: path outside your memory directory." };
        await writeFile(p, content); return { text: `Saved ${file ?? "MEMORY.md"}.` };
      },
    }),
    append_memory: tool({
      description: "Append a line/section to one of your persistent memory files (default MEMORY.md).",
      inputSchema: z.object({ file: z.string().optional(), content: z.string() }),
      execute: async ({ file, content }) => {
        const p = await guard(file ?? "MEMORY.md");
        if (!p) return { text: "Refused: path outside your memory directory." };
        await appendFile(p, content.endsWith("\n") ? content : content + "\n"); return { text: `Appended to ${file ?? "MEMORY.md"}.` };
      },
    }),
  };
}
```

(If `@mycelium/leash-core/json-store` doesn't re-export `DATA_DIR`, import it the way `agents-store.ts` does — confirm the working import at implementation; the env override `LEASH_AGENT_MEMORY_DIR` is what the test relies on.)

- [ ] **Step 4: Run the test — verify it passes**

Run: `npx tsx apps/web/scripts/agent-memory.test.ts`
Expected: `agent-memory: PASS`

- [ ] **Step 5: Inject memory into `buildOne`**

Add the import to `agent-runner.ts`:
```typescript
import { readMemoryContext, agentMemoryTools } from "./agent-memory.ts";
```
In `buildOne`'s `execute` (Task 3 already restructured it), compute memory context/tools and fold them in. After `const skillCtx = await preloadSkills(agent);` add:
```typescript
        const memCtx = agent.memory ? await readMemoryContext(agent.slug) : "";
        const memTools = agent.memory ? agentMemoryTools(agent.slug) : {};
```
Change the `merged` toolset to include `memTools`, and append `memCtx` to `instructions`:
```typescript
          const merged: ToolSet = { ...(names.length ? tools : {}), ...inline.tools, ...memTools };
          ...
          instructions: (agent.body || `You are the "${agent.name}" agent. Carry out the task and end with a clear, self-contained summary of your result.`) + skillCtx + memCtx,
```

- [ ] **Step 6: Rebuild check, type-check, commit**

```bash
npx tsx apps/web/scripts/agent-memory.test.ts   # still PASS
npx tsc -p apps/web --noEmit 2>&1 | grep "error TS"   # only the 2 known
git add apps/web/lib/leash/agent-memory.ts apps/web/lib/leash/agent-runner.ts apps/web/scripts/agent-memory.test.ts
git commit -m "feat(agents): wire memory: per-agent sandboxed persistent dir + MEMORY.md injection"
```

---

### Task 5: Surface the new + reserved fields in AgentsPanel

**Files:**
- Modify: `apps/web/components/AgentsPanel.tsx`

**Interfaces:**
- Consumes: the `Agent` JSON now carries `mcpServers`/`memory`/reserved fields (Task 1).

- [ ] **Step 1: Extend the client `Agent` type**

In `AgentsPanel.tsx`, add to the local `Agent` interface (the JSON mirror):
```typescript
  mcpServers: { refs: string[]; inline: unknown[] };
  memory: string;
  permissionMode: string;
  hooks: string;
  background: boolean;
  effort: string;
  isolation: string;
  color: string;
  initialPrompt: string;
```

- [ ] **Step 2: Render a read-only "Reserved" section in the agent detail/editor**

Where an agent's details are shown (the row/editor area), add a compact read-only block listing any populated reserved fields. Use existing idioms (`kicker`, `var(--color-faint)`, `var(--color-muted)`); show only fields with a value, and a "parsed — not yet wired" caption. Also display the active fields (`memory` scope, `mcpServers` ref/inline counts). For a plugin agent (`source === "plugin"`), show `mcpServers`/`permissionMode`/`hooks` greyed with an "ignored for plugin agents" note. Example block to place in the agent's rendered card:
```tsx
{(a.memory || a.mcpServers.refs.length || a.mcpServers.inline.length) && (
  <p className="kicker" style={{ color: "var(--color-muted)" }}>
    {a.memory ? `memory: ${a.memory}` : ""}
    {a.mcpServers.refs.length || a.mcpServers.inline.length ? ` · mcp: ${a.mcpServers.refs.length} ref + ${a.mcpServers.inline.length} inline` : ""}
  </p>
)}
{[a.permissionMode && `permissionMode: ${a.permissionMode}`, a.effort && `effort: ${a.effort}`, a.color && `color: ${a.color}`, a.background && "background", a.isolation && `isolation: ${a.isolation}`, a.initialPrompt && "initialPrompt", a.hooks && "hooks"].filter(Boolean).length > 0 && (
  <p className="kicker" style={{ color: "var(--color-faint)" }}>
    reserved (parsed, not yet wired): {[a.permissionMode && `permissionMode=${a.permissionMode}`, a.effort && `effort=${a.effort}`, a.color && `color=${a.color}`, a.background && "background", a.isolation && `isolation=${a.isolation}`, a.initialPrompt && "initialPrompt", a.hooks && "hooks"].filter(Boolean).join(", ")}
    {a.source === "plugin" ? " — mcpServers/permissionMode/hooks ignored for plugin agents" : ""}
  </p>
)}
```
(Adapt to the actual JSX structure of the card; keep it read-only — no new editing controls in Phase C.)

- [ ] **Step 3: Type-check + commit**

```bash
npx tsc -p apps/web --noEmit 2>&1 | grep "error TS"   # only the 2 known
git add apps/web/components/AgentsPanel.tsx
git commit -m "feat(agents): surface mcpServers/memory + reserved frontmatter fields in the dashboard"
```

---

### Task 6: Whole-feature verification + e2e

**Files:** none (verification only).

- [ ] **Step 1: Run every agent test + the Phase A/B tests**

```bash
cd /Volumes/Development/qvac/mycelium
for t in agent-frontmatter agent-mcp-refs agent-memory agent-builtin specialist-agents main-agent conductor; do npx tsx apps/web/scripts/$t.test.ts; done
```
Expected: each prints `… PASS`.

- [ ] **Step 2: Type-check**

```bash
npx tsc -b packages/leash-core && npx tsc -p apps/web --noEmit 2>&1 | grep "error TS" | sort | uniq
```
Expected: only `provider.ts` (TS2724) and `verify-data-dir-env.ts` (TS2345).

- [ ] **Step 3: Manual e2e (deferred items — needs a warm model + a configured MCP server)**

Document/perform as available:
- A user agent with `memory: user`: across two delegate invocations, it writes to and then reads back its `MEMORY.md` at `<dataDir>/agent-memory/<slug>/` (confirm the file exists and grows).
- A user agent with `mcpServers: | { "<an-already-configured-server>": {} }`: its delegate run can call that server's tools; a non-referencing agent cannot (unless it lists them in `tools:`).
- A user agent with an inline `mcpServers` def: its delegate gets that server's tools during the run; the main conversation does not; the connection is closed after (no leaked process).
- The Brain → Agents tab shows the reserved fields read-only and the active `memory`/`mcp` summary; a plugin agent shows the ignored-fields note.

- [ ] **Step 4: Final commit (if verification needed fixes)**

```bash
git add -A && git commit -m "test(agents): Phase C whole-feature verification" || echo "nothing to commit"
```

---

## Verification (summary)

- **Automated:** `agent-frontmatter`, `agent-mcp-refs`, `agent-memory` (+ A/B tests) PASS; `tsc -b packages/leash-core` clean; `tsc -p apps/web` only the 2 known pre-existing errors.
- **Parity:** camelCase + kebab both parse; reserved fields stored + surfaced, inert; plugin agents strip `mcpServers`/`permissionMode`/`hooks`; `model` never a cloud alias.
- **mcpServers:** references grant an already-connected server's tools; inline defs connect-on-start / disconnect-on-finish, invisible to the main conversation.
- **memory:** `user` scope dir; `MEMORY.md` injected (capped); sandboxed read/append/write tools reject traversal.
