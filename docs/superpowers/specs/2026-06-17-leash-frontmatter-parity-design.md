# Phase C — Full Claude-standard agent frontmatter parity

**Date:** 2026-06-17
**Status:** Design — approved for planning
**Layer:** Mind (the agent model + delegation runtime + Brain → Agents surface)
**Part of:** the unified-agents direction. See [[agents-unified-architecture]]. Phase A made the
chat route load its base from a markdown agent def; Phase B added the specialist delegate roster.
**Phase C** brings the agent definition to **full parity with the Claude Code sub-agent standard**.

**Source of truth for the standard:** https://code.claude.com/docs/en/sub-agents (the "Supported
frontmatter fields" table). This spec maps every Claude field onto Mycelium's on-device runtime.

## Why

The architecture mandate: *parse/store/surface the FULL Claude sub-agent field set; each field is
ACTIVE or RESERVED — nothing is "unsupported."* Today the `Agent` model implements 8 of Claude's
~16 fields and silently ignores the rest. Phase C closes the gap: **implement `mcpServers` +
`memory`** (the two the user wants live), **reserve the remainder** (parsed, stored, surfaced as
"not yet wired"), and accept Claude's exact field names alongside our existing kebab-case.

## The standard → Mycelium field map

| Claude field | Status in Phase C | Mycelium mapping |
|---|---|---|
| `name` (req) | ✅ have | `Agent.name` |
| `description` (req) | ✅ have | `Agent.description` (delegation trigger) |
| `tools` | ✅ have | `Agent.tools` (also accept omitted ⇒ current "sane default") |
| `disallowedTools` | ✅ have | `Agent.disallowedTools` (accept `disallowed-tools` too) |
| `model` | ✅ have — **hard divergence** | QVAC served alias only (Hard Rule 1). Claude's `inherit`/omitted ⇒ our empty-default. NEVER `sonnet`/`opus`/`haiku`/`fable`. |
| `maxTurns` | ✅ have | `Agent.maxTurns` (accept `max-turns` too) |
| `skills` | ✅ have | `Agent.skills` |
| body (`prompt`) | ✅ have | `Agent.body` |
| **`mcpServers`** | 🟢 IMPLEMENT | reference-by-name + inline def (below) |
| **`memory`** | 🟢 IMPLEMENT | scope enum → per-agent persistent dir + `MEMORY.md` injection (below) |
| `permissionMode` | 🟡 RESERVE | enum stored raw; inert for delegates (they can't approve) |
| `hooks` | 🟡 RESERVE | stored raw |
| `background` | 🟡 RESERVE | boolean stored |
| `effort` | 🟡 RESERVE | enum stored (a live `effort` subsystem exists, but wiring is out of scope) |
| `isolation` | 🟡 RESERVE | stored (worktree — N/A to the single-turn on-device loop) |
| `color` | 🟡 RESERVE | enum stored (UI-only; surfaced) |
| `initialPrompt` | 🟡 RESERVE | stored (only meaningful for agent-as-main, the latent future) |

## Decisions (locked during brainstorming)

1. **Match the doc; adapt only where on-device forces it.** The Claude doc is the standard.
2. **`mcpServers` is BOTH forms** (per the doc): a **string reference** to an already-configured
   server (shares the global/parent connection — lightweight) OR an **inline definition** (same
   schema as `.mcp.json`: `stdio`/`http`/`sse`, keyed by name) **connected when the delegate
   starts, disconnected when it finishes**.
3. **`memory` is a SCOPE enum** (`user`/`project`/`local`), NOT a boolean, and NOT the existing
   `remember`/`recall` personal-memory system. It gives the agent its OWN persistent directory
   with a `MEMORY.md` for cross-session learnings. **On-device adaptation:** implement **`user`**
   → `<dataDir>/agent-memory/<slug>/`; **reserve `project`/`local`** (no git "project" on the
   device mesh) — they parse/store but fall back to the `user` dir with a surfaced note.
4. **Parser:** keep the hand-rolled flat frontmatter parser. The two structured fields
   (`mcpServers`, `hooks`) are authored as a **JSON value in a block scalar** (`field: |` + JSON);
   reserved fields store their **raw string verbatim** (lossless). No new YAML dependency.
5. **Wiring scope = delegates.** `mcpServers`/`memory` wire for agents invoked **as delegates**
   (the specialists + user agents). The main Leash turn keeps its current full access; agent-as-
   main stays the latent future (so `initialPrompt` etc. remain reserved).
6. **Plugin-agent parity (security):** for `source: "plugin"` agents, **ignore `mcpServers`,
   `permissionMode`, and `hooks`** (mirrors the Claude doc's plugin-subagent restriction).

## Architecture

```
Agent def (markdown) ──parse──> Agent { …existing…, mcpServers, memory, + reserved fields }
                                          │            │
delegate invocation (agent-runner buildOne):          │
  agentTools(agent, registry):                        │
    • base allow-set (tools ∩ registry − denied − approval-gated − no-nest)   [unchanged]
    • + mcpServers REFERENCES → that server's tools from the global registry
    • + mcpServers INLINE → connect now, add tools, schedule disconnect-on-finish
  memoryContext(agent):                               │
    • if memory set → resolve dir, read MEMORY.md (cap 200 lines/25KB),
      inject into instructions, add sandboxed agent-memory tools (read/append/write
      within the agent's dir only — NOT approval-gated, since sandboxed)
  ToolLoopAgent({ instructions: body + skills + memoryContext, tools: base+mcp+memoryTools })
```

### Component 1 — Extend the `Agent` model + parser (`packages/leash-core/src/agents-store.ts`, `frontmatter.ts`)

- Add to `Agent`: `mcpServers: AgentMcpServers` (`{ refs: string[]; inline: McpServerEntry[] }`),
  `memory: "" | "user" | "project" | "local"`, and the reserved fields: `permissionMode: string`,
  `hooks: string` (raw), `background: boolean`, `effort: string`, `isolation: string`,
  `color: string`, `initialPrompt: string`.
- `buildAgent`: accept **both** Claude camelCase and our kebab/lower variants for every field
  (the existing `fields["disallowed-tools"] ?? fields["disallowedtools"]` pattern, extended to
  `maxTurns`/`max-turns`, `disallowedTools`/`disallowed-tools`, etc.).
- New `parseAgentMcpServers(raw)` (in agents-store or frontmatter): JSON-parse a block-scalar value
  shaped `{ "<name>": {} | <McpServerInput> }`; an empty/`{}` value ⇒ a **reference** (`refs`), a
  populated object ⇒ an **inline** def validated through the existing `validateServerInput`
  (`mcp-config.ts`). Malformed ⇒ skip that entry, keep the rest, never throw.
- New `parseMemoryScope(raw)`: lowercase; accept `user|project|local`; anything else ⇒ `""`.
- Reserved fields: parsed to their raw trimmed string/boolean and stored; `permissionMode`/`effort`/
  `color` validated against their enums (invalid ⇒ `""`, logged) but otherwise inert.
- `serializeAgent`: write back every present field (camelCase to match the standard on write;
  `mcpServers`/`hooks` as a JSON block scalar).
- **Plugin stripping:** when `source === "plugin"`, force `mcpServers`/`permissionMode`/`hooks`
  to empty in `buildAgent` (parsed-then-dropped, with a surfaced note).

### Component 2 — Wire `mcpServers` into delegation (`apps/web/lib/leash/agent-runner.ts`, `mcp.ts`)

- In `agentTools(agent, registry)`: after the existing allow-set, if `agent.mcpServers.refs`,
  add the tool-names belonging to each referenced server (resolve server→tools from the live MCP
  registry connections, `mcp.ts`). References share the already-open global connection.
- In `buildOne`'s `execute` (around the `ToolLoopAgent` run): if `agent.mcpServers.inline`,
  **connect** those servers via the existing `mcp.ts` connect primitive *before* the sub-agent
  runs, merge their tools into the delegate's toolset, and **disconnect** them in a `finally`
  after the sub-agent finishes (connected-on-start / disconnected-on-finish, per the doc).
- Inline servers are NOT added to the global store and NOT visible to the main conversation (the
  doc's "keep it out of the main conversation" property).

### Component 3 — Wire `memory` into delegation (`apps/web/lib/leash/agent-runner.ts` + a new `agent-memory.ts`)

- New `apps/web/lib/leash/agent-memory.ts`:
  - `memoryDir(slug)` → `<dataDir>/agent-memory/<slug>/` (the `user` scope; `project`/`local`
    fall back here in Phase C).
  - `readMemoryContext(slug)` → the first 200 lines / 25KB of `<dir>/MEMORY.md` (empty string if
    absent), wrapped as an instructions section: `--- Your persistent memory (read & keep it
    current) ---\n<content>`.
  - A **sandboxed agent-memory toolset** (`agentMemoryTools(slug)`): read/append/write files
    **only within** `memoryDir(slug)` (path-jailed; reject traversal). NOT approval-gated (safe by
    sandboxing), so delegates may use it. Mirrors Claude's "Read/Write/Edit auto-enabled on the
    memory dir."
- In `buildOne`: if `agent.memory`, append `readMemoryContext(slug)` to the sub-agent's
  `instructions` and merge `agentMemoryTools(slug)` into its toolset.

### Component 4 — Surface reserved + new fields (`apps/web/components/AgentsPanel.tsx`)

- The client `Agent` type gains the new fields. The editor shows a **"Reserved — parsed, not yet
  wired"** section listing `permissionMode`/`hooks`/`background`/`effort`/`isolation`/`color`/
  `initialPrompt` (read-only display of stored values) and `mcpServers`/`memory` as active
  (editable). Plugin agents show the stripped fields greyed with an "ignored for plugin agents"
  note. No new styles — reuse existing panel idioms.

## Data flow

1. Agent `.md` parsed → `Agent` with `mcpServers`/`memory`/reserved populated (plugin agents have
   `mcpServers`/`permissionMode`/`hooks` stripped).
2. Delegate invoked → `agentTools` adds referenced-server tools; `buildOne` connects inline
   servers (finally-disconnects), injects memory context + sandboxed memory tools.
3. Sub-agent runs with: body + skills + memory context, and tools = allow-set + mcp (ref+inline) +
   memory tools.
4. Reserved fields are stored + surfaced but do not affect the run.

## Error handling

- Parser never throws: malformed `mcpServers` entries / bad `memory` scope / invalid enum values
  degrade to empty + a logged warning; the rest of the agent loads.
- Inline MCP connect failure → log, skip that server, run the delegate without it; always
  disconnect in `finally` (no leaked connections).
- `agentMemoryTools` reject any path outside the agent's dir; missing `MEMORY.md` ⇒ empty context.

## Testing

- **Parser (tsx + node:assert):** camelCase and kebab both parse; reserved fields stored raw;
  `parseAgentMcpServers` splits refs vs inline (inline validated, malformed skipped);
  `parseMemoryScope` accepts user/project/local, rejects junk; plugin-source strips
  `mcpServers`/`permissionMode`/`hooks`; `model` never coerces to a cloud alias.
- **mcpServers refs (unit-ish):** given a fake registry with server→tools, `agentTools` grants the
  referenced server's tool names.
- **memory (unit-ish):** `memoryDir` path; `readMemoryContext` caps at 200 lines/25KB; the
  sandboxed memory tools reject `../` traversal and read/append within the dir.
- **Type-check:** `tsc -p apps/web` + `tsc -b packages/leash-core` (rebuild — leash-core is
  consumed as `dist/`); only the known pre-existing errors.
- **Manual e2e (deferred, needs a warm model):** a delegate with an inline `mcpServers` gets that
  server's tools for its run and not after; a delegate with `memory: user` reads/writes its
  `MEMORY.md` across two invocations; the dashboard shows reserved fields read-only.

## Scope boundaries (YAGNI)

- Only `mcpServers` + `memory` wire. `permissionMode`/`hooks`/`background`/`effort`/`isolation`/
  `color`/`initialPrompt` are reserved (stored + surfaced, inert).
- `memory` implements the `user` scope only; `project`/`local` parse but fall back to `user`.
- No agent-as-main, so `initialPrompt`/`background`/`isolation` have no runtime effect.
- No change to the main Leash turn's tool/memory access; wiring is delegate-only.
- No new YAML dependency; structured fields use JSON block scalars.
- Do not touch the Conductor, the route's dynamic assembly, or the existing remember/recall system.

## Build order

1. Extend `Agent` model + parser (camelCase/kebab aliases, reserved fields raw-stored,
   `parseAgentMcpServers`, `parseMemoryScope`, plugin stripping) + parser tests. Rebuild leash-core.
2. `mcpServers` references — grant referenced servers' tools in `agentTools` + test.
3. `mcpServers` inline — connect-on-start / disconnect-on-finish in `buildOne`.
4. `memory` — `agent-memory.ts` (dir, context, sandboxed tools) + wire into `buildOne` + tests.
5. AgentsPanel — surface active + reserved fields (read-only reserved section, plugin greying).
6. Type-check + manual e2e.
