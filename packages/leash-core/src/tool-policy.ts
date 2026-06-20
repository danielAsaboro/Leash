/**
 * Hard tool policy for Leash orchestration.
 *
 * Prompts can describe what tools are for, but this module decides which tools may
 * be exposed or executed in a route/sub-agent/background/public-mesh context. The
 * web chat route and deterministic runners filter through this before any model
 * sees tools; wrappers also redact tool outputs before they are persisted or fed
 * into later model turns.
 */
import type { ToolSet } from "ai";
import { createHash } from "node:crypto";
import { TOOL_GROUPS } from "./groups/index.ts";

export type ToolRoute = "chat" | "health" | "computer" | "files" | "vision" | "plan" | "skill" | "agent" | "background";
export type ToolScope =
  | "private_context"
  | "memory"
  | "tasks"
  | "home"
  | "device"
  | "files"
  | "mcp_admin"
  | "scheduler"
  | "network"
  | "media"
  | "orchestration"
  | "router";
export type ToolRisk = "read" | "low_write" | "write" | "device_control" | "shell" | "network" | "admin";
export type ToolApproval = "none" | "required";

export interface ToolPolicy {
  name: string;
  scope: ToolScope;
  risk: ToolRisk;
  approval: ToolApproval;
  allowedRoutes: ToolRoute[];
  subagentAllowed: boolean;
  backgroundAllowed: boolean;
  publicMeshAllowed: boolean;
}

export interface ToolPolicyContext {
  route: ToolRoute;
  runId?: string;
  stepId?: string;
  subagent?: boolean;
  background?: boolean;
  publicMesh?: boolean;
}

export interface ToolPolicyDecision {
  ok: boolean;
  reason?: string;
  policy: ToolPolicy;
}

export interface ToolApprovalBinding {
  toolName: string;
  argsHash: string;
  route: ToolRoute;
  runId: string;
  stepId: string;
}

const READ_SAFE: Pick<ToolPolicy, "risk" | "approval" | "subagentAllowed" | "backgroundAllowed" | "publicMeshAllowed"> = {
  risk: "read",
  approval: "none",
  subagentAllowed: true,
  backgroundAllowed: true,
  publicMeshAllowed: false,
};

const MAIN_ONLY_READ: Pick<ToolPolicy, "risk" | "approval" | "subagentAllowed" | "backgroundAllowed" | "publicMeshAllowed"> = {
  risk: "read",
  approval: "none",
  subagentAllowed: false,
  backgroundAllowed: false,
  publicMeshAllowed: false,
};

const LOW_WRITE: Pick<ToolPolicy, "risk" | "approval" | "subagentAllowed" | "backgroundAllowed" | "publicMeshAllowed"> = {
  risk: "low_write",
  approval: "none",
  subagentAllowed: false,
  backgroundAllowed: false,
  publicMeshAllowed: false,
};

const APPROVED_ACTION: Pick<ToolPolicy, "approval" | "subagentAllowed" | "backgroundAllowed" | "publicMeshAllowed"> = {
  approval: "required",
  subagentAllowed: false,
  backgroundAllowed: false,
  publicMeshAllowed: false,
};

const GROUP_DEFAULTS: Record<string, Omit<ToolPolicy, "name">> = {
  "home-assistant": { scope: "home", risk: "device_control", approval: "required", allowedRoutes: ["chat", "computer"], subagentAllowed: false, backgroundAllowed: false, publicMeshAllowed: false },
  feed: { scope: "private_context", allowedRoutes: ["chat", "plan", "skill", "agent"], ...READ_SAFE },
  memory: { scope: "memory", allowedRoutes: ["chat", "health", "plan", "skill", "agent"], ...READ_SAFE },
  tasks: { scope: "tasks", allowedRoutes: ["chat", "plan"], ...LOW_WRITE },
  context: { scope: "private_context", allowedRoutes: ["chat", "health", "plan", "skill", "agent"], ...READ_SAFE },
  photos: { scope: "private_context", allowedRoutes: ["chat", "vision"], ...MAIN_ONLY_READ },
  image: { scope: "media", allowedRoutes: ["chat"], ...LOW_WRITE },
  research: { scope: "network", risk: "network", approval: "required", allowedRoutes: ["chat"], subagentAllowed: false, backgroundAllowed: true, publicMeshAllowed: false },
  skills: { scope: "orchestration", allowedRoutes: ["chat", "plan", "skill", "agent"], ...READ_SAFE },
  computer: { scope: "device", risk: "device_control", approval: "required", allowedRoutes: ["computer"], subagentAllowed: false, backgroundAllowed: false, publicMeshAllowed: false },
  files: { scope: "files", allowedRoutes: ["files", "chat", "plan", "skill", "agent"], ...READ_SAFE },
  "mcp-admin": { scope: "mcp_admin", risk: "admin", approval: "required", allowedRoutes: ["chat"], subagentAllowed: false, backgroundAllowed: false, publicMeshAllowed: false },
  scheduler: { scope: "scheduler", risk: "write", approval: "required", allowedRoutes: ["chat"], subagentAllowed: false, backgroundAllowed: false, publicMeshAllowed: false },
  router: { scope: "router", allowedRoutes: ["chat", "plan", "skill", "agent"], ...READ_SAFE },
};

const TOOL_OVERRIDES: Record<string, Partial<Omit<ToolPolicy, "name">>> = {
  ha_list_entities: { risk: "read", approval: "none", allowedRoutes: ["chat"], subagentAllowed: true },
  ha_get_state: { risk: "read", approval: "none", allowedRoutes: ["chat"], subagentAllowed: true },
  ha_call_service: { risk: "device_control", approval: "required", allowedRoutes: ["chat", "computer"], subagentAllowed: false },

  remember: { risk: "low_write", approval: "none", allowedRoutes: ["chat"], subagentAllowed: false, backgroundAllowed: false },
  recall: { risk: "read", approval: "none", allowedRoutes: ["chat", "health", "plan", "skill", "agent"], subagentAllowed: true, backgroundAllowed: true },

  create_task: { risk: "low_write", approval: "none", allowedRoutes: ["chat", "plan"], subagentAllowed: false },
  update_task: { risk: "low_write", approval: "none", allowedRoutes: ["chat", "plan"], subagentAllowed: false },
  list_tasks: { risk: "read", approval: "none", allowedRoutes: ["chat", "plan", "skill", "agent"], subagentAllowed: true },

  list_photos: { allowedRoutes: ["chat", "vision"], subagentAllowed: false },
  generate_image: { risk: "low_write", approval: "none", allowedRoutes: ["chat"], subagentAllowed: false, backgroundAllowed: false },

  read_skill: { allowedRoutes: ["chat", "plan", "skill", "agent"], subagentAllowed: true },
  read_skill_file: { allowedRoutes: ["chat", "plan", "skill", "agent"], subagentAllowed: true },
  run_skill_script: { risk: "shell", approval: "required", allowedRoutes: ["chat"], subagentAllowed: false, backgroundAllowed: false },

  screenshot: { risk: "read", approval: "none", allowedRoutes: ["computer"], subagentAllowed: false, backgroundAllowed: false },
  run_command: { risk: "shell", approval: "required", allowedRoutes: ["computer"], subagentAllowed: false, backgroundAllowed: false },
  computer: { risk: "device_control", approval: "required", allowedRoutes: ["computer"], subagentAllowed: false, backgroundAllowed: false },
  bash: { scope: "files", risk: "read", approval: "none", allowedRoutes: ["files", "chat", "plan", "skill", "agent"], subagentAllowed: true, backgroundAllowed: true },

  install_mcp_repo: { risk: "admin", approval: "required", allowedRoutes: ["chat"], subagentAllowed: false, backgroundAllowed: false },
  upsert_mcp_server: { risk: "admin", approval: "required", allowedRoutes: ["chat"], subagentAllowed: false, backgroundAllowed: false },

  schedule_reminder: { risk: "write", approval: "required", allowedRoutes: ["chat"], subagentAllowed: false, backgroundAllowed: false },
  schedule_job: { risk: "write", approval: "required", allowedRoutes: ["chat"], subagentAllowed: false, backgroundAllowed: false },
  enable_schedule: { risk: "write", approval: "required", allowedRoutes: ["chat"], subagentAllowed: false, backgroundAllowed: false },
  disable_schedule: { risk: "write", approval: "required", allowedRoutes: ["chat"], subagentAllowed: false, backgroundAllowed: false },
  remove_schedule: { risk: "write", approval: "required", allowedRoutes: ["chat"], subagentAllowed: false, backgroundAllowed: false },
};

const CONTROL_POLICIES: Record<string, ToolPolicy> = {
  run_skill: {
    name: "run_skill",
    scope: "orchestration",
    risk: "read",
    approval: "none",
    allowedRoutes: ["chat"],
    subagentAllowed: false,
    backgroundAllowed: false,
    publicMeshAllowed: false,
  },
  submit_plan: {
    name: "submit_plan",
    scope: "orchestration",
    risk: "low_write",
    approval: "required",
    allowedRoutes: ["chat"],
    subagentAllowed: false,
    backgroundAllowed: false,
    publicMeshAllowed: false,
  },
  read_memory: {
    name: "read_memory",
    scope: "memory",
    risk: "read",
    approval: "none",
    allowedRoutes: ["agent"],
    subagentAllowed: true,
    backgroundAllowed: false,
    publicMeshAllowed: false,
  },
  write_memory: {
    name: "write_memory",
    scope: "memory",
    risk: "low_write",
    approval: "none",
    allowedRoutes: ["agent"],
    subagentAllowed: true,
    backgroundAllowed: false,
    publicMeshAllowed: false,
  },
  append_memory: {
    name: "append_memory",
    scope: "memory",
    risk: "low_write",
    approval: "none",
    allowedRoutes: ["agent"],
    subagentAllowed: true,
    backgroundAllowed: false,
    publicMeshAllowed: false,
  },
};

const APPLE_NOTES_READ_TOOLS = new Set([
  "search-notes",
  "get-note-content",
  "get-note-details",
  "get-note-by-id",
  "list-notes",
  "list-folders",
  "list-accounts",
  "get-note-markdown",
  "get-checklist-state",
  "list-attachments",
  "fetch-attachment",
  "health-check",
  "doctor",
  "get-notes-stats",
  "get-sync-status",
  "list-shared-notes",
  "search_notes",
  "search_tags",
  "read_note",
  "read_folder",
  "diagnostics",
  "note_list",
  "note_get",
  "note_sync_status",
]);

const APPLE_NOTES_WRITE_TOOLS = new Set([
  "create-note",
  "update-note",
  "delete-note",
  "move-note",
  "create-folder",
  "delete-folder",
  "batch-delete-notes",
  "batch-move-notes",
  "save-attachment",
  "note_sync",
  "create_note",
  "append_note",
]);

const APPLE_NOTES_BULK_READ_TOOLS = new Set(["export-notes-json"]);

function appleNotesPolicy(name: string): ToolPolicy | null {
  if (APPLE_NOTES_READ_TOOLS.has(name)) {
    return {
      name,
      scope: "private_context",
      risk: "read",
      approval: "none",
      allowedRoutes: ["chat", "health", "plan", "skill", "agent"],
      subagentAllowed: true,
      backgroundAllowed: false,
      publicMeshAllowed: false,
    };
  }
  if (APPLE_NOTES_WRITE_TOOLS.has(name)) {
    return {
      name,
      scope: "private_context",
      risk: "write",
      approval: "required",
      allowedRoutes: ["chat"],
      subagentAllowed: false,
      backgroundAllowed: false,
      publicMeshAllowed: false,
    };
  }
  if (APPLE_NOTES_BULK_READ_TOOLS.has(name)) {
    return {
      name,
      scope: "private_context",
      risk: "read",
      approval: "required",
      allowedRoutes: ["chat"],
      subagentAllowed: false,
      backgroundAllowed: false,
      publicMeshAllowed: false,
    };
  }
  return null;
}

function builtinPolicies(): Record<string, ToolPolicy> {
  const out: Record<string, ToolPolicy> = {};
  for (const group of TOOL_GROUPS) {
    const base = GROUP_DEFAULTS[group.id];
    if (!base) continue;
    for (const t of group.tools) {
      const policy: ToolPolicy = { name: t.name, ...base, ...(TOOL_OVERRIDES[t.name] ?? {}) };
      out[t.name] = t.needsApproval ? { ...policy, approval: "required" } : policy;
    }
  }
  return { ...out, ...CONTROL_POLICIES };
}

const BUILTIN_POLICIES = builtinPolicies();

/** Unknown enabled MCP tools fail closed for sub-agents/background/public mesh and ask first on the main turn. */
export function defaultToolPolicy(name: string): ToolPolicy {
  if (name.startsWith("agent__")) {
    return {
      name,
      scope: "orchestration",
      risk: "read",
      approval: "none",
      allowedRoutes: ["chat"],
      subagentAllowed: false,
      backgroundAllowed: false,
      publicMeshAllowed: false,
    };
  }
  return {
    name,
    scope: "mcp_admin",
    risk: "admin",
    approval: "required",
    allowedRoutes: ["chat"],
    subagentAllowed: false,
    backgroundAllowed: false,
    publicMeshAllowed: false,
  };
}

export function toolPolicy(name: string): ToolPolicy {
  return BUILTIN_POLICIES[name] ?? appleNotesPolicy(name) ?? defaultToolPolicy(name);
}

export function allBuiltinToolPolicies(): Record<string, ToolPolicy> {
  return { ...BUILTIN_POLICIES };
}

export function policyDefaultAskFirstNames(): string[] {
  return Object.values(BUILTIN_POLICIES)
    .filter((p) => p.approval === "required")
    .map((p) => p.name)
    .sort();
}

export function policyRequiresApproval(name: string): boolean {
  return toolPolicy(name).approval === "required";
}

export function assertBuiltinToolPolicyCoverage(): void {
  const missing = TOOL_GROUPS.flatMap((g) => g.tools.map((t) => t.name).filter((name) => !BUILTIN_POLICIES[name]));
  if (missing.length) throw new Error(`missing tool policy for: ${missing.join(", ")}`);
}

export function toolPolicyDecision(name: string, context: ToolPolicyContext): ToolPolicyDecision {
  const policy = toolPolicy(name);
  if (!policy.allowedRoutes.includes(context.route)) {
    return { ok: false, policy, reason: `${name} is not allowed on ${context.route} route` };
  }
  if (context.subagent && !policy.subagentAllowed) {
    return { ok: false, policy, reason: `${name} is not allowed in sub-agents` };
  }
  if (context.background && !policy.backgroundAllowed) {
    return { ok: false, policy, reason: `${name} is not allowed in background runs` };
  }
  if (context.publicMesh && !policy.publicMeshAllowed) {
    return { ok: false, policy, reason: `${name} is not allowed on public mesh routes` };
  }
  return { ok: true, policy };
}

export function isToolAllowed(name: string, context: ToolPolicyContext): boolean {
  return toolPolicyDecision(name, context).ok;
}

export function filterToolNamesForContext(names: string[], context: ToolPolicyContext): string[] {
  return names.filter((name) => isToolAllowed(name, context));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk|rk|pk)_[A-Za-z0-9_-]{20,}\b/g,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
  /\b(?:api[_-]?key|token|secret|password|mnemonic|private[_-]?key)\s*[:=]\s*["']?[^"'\s,;]+/gi,
];

const PROMPT_INJECTION_PATTERNS: RegExp[] = [
  /\bignore (?:all )?(?:previous|above|prior) instructions\b/gi,
  /\b(?:system|developer|assistant) instructions?\s*:/gi,
  /\bcopy this into your system prompt\b/gi,
];

export function redactString(input: string): string {
  let out = input;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted-secret]");
  for (const re of PROMPT_INJECTION_PATTERNS) out = out.replace(re, "[redacted-untrusted-instruction]");
  return out.length > 24_000 ? out.slice(0, 24_000) + "\n[truncated]" : out;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

export function argsHash(args: unknown): string {
  return createHash("sha256").update(canonicalJson(args)).digest("hex");
}

export function approvalBinding(name: string, args: unknown, context: ToolPolicyContext): ToolApprovalBinding {
  if (!context.runId || !context.stepId) throw new Error("approval binding requires runId and stepId");
  return { toolName: name, argsHash: argsHash(args), route: context.route, runId: context.runId, stepId: context.stepId };
}

export function approvalMatches(binding: ToolApprovalBinding, name: string, args: unknown, context: ToolPolicyContext): boolean {
  return (
    binding.toolName === name &&
    binding.argsHash === argsHash(args) &&
    binding.route === context.route &&
    binding.runId === context.runId &&
    binding.stepId === context.stepId
  );
}

export function redactToolOutput<T>(value: T): T {
  if (typeof value === "string") return redactString(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactToolOutput(v)) as T;
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (/secret|token|password|mnemonic|private[_-]?key|api[_-]?key/i.test(k)) out[k] = "[redacted-secret]";
    else out[k] = redactToolOutput(v);
  }
  return out as T;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return !!value && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function";
}

async function* redactAsyncIterable(iter: AsyncIterable<unknown>): AsyncIterable<unknown> {
  for await (const item of iter) yield redactToolOutput(item);
}

/**
 * Filter a ToolSet to tools allowed in `context` and wrap execute() with the same
 * check plus output redaction. Filtering keeps forbidden schemas away from the
 * model; the wrapper is the last line of defense if a tool object is reused.
 */
export function enforceToolPolicy<T extends ToolSet>(tools: T, context: ToolPolicyContext): ToolSet {
  const out: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    const decision = toolPolicyDecision(name, context);
    if (!decision.ok) continue;
    const maybeExecute = (tool as { execute?: unknown }).execute;
    if (typeof maybeExecute !== "function") {
      out[name] = tool;
      continue;
    }
    const isAsyncGenerator = maybeExecute.constructor?.name === "AsyncGeneratorFunction";
    if (isAsyncGenerator) {
      out[name] = {
        ...tool,
        execute: async function* (args: unknown, opts: unknown) {
          const liveDecision = toolPolicyDecision(name, context);
          if (!liveDecision.ok) throw new Error(`tool policy denied ${name}: ${liveDecision.reason}`);
          const result = maybeExecute.call(tool, args, opts);
          if (isAsyncIterable(result)) {
            for await (const item of result) yield redactToolOutput(item);
          } else {
            yield redactToolOutput(await result);
          }
        },
      } as ToolSet[string];
      continue;
    }
    out[name] = {
      ...tool,
      execute: async (args: unknown, opts: unknown) => {
        const liveDecision = toolPolicyDecision(name, context);
        if (!liveDecision.ok) throw new Error(`tool policy denied ${name}: ${liveDecision.reason}`);
        const result = await maybeExecute.call(tool, args, opts);
        return isAsyncIterable(result) ? redactAsyncIterable(result) : redactToolOutput(result);
      },
    } as ToolSet[string];
  }
  return out;
}
