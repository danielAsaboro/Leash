/**
 * LIVE multi-agent orchestration proof (needs `qvac serve`) — the eval-critical capability:
 * "multi-agent workflows with orchestration and tool calling," on real on-device qwen3-4b.
 *
 * FIDELITY NOTE: the production sub-agent runner is `apps/web/lib/leash/agent-runner.ts`. It can't be
 * imported under tsx (the web modules load as CJS and `@qvac/ai-sdk-provider` ships only an ESM export;
 * the real path only runs inside Next + auth). So this script uses the REAL stores (leash-core) + the
 * REAL on-device model + the SAME AI SDK primitives, and INLINES the exact same buildAgentTools logic
 * (one tool per agent → focused generateText over the agent's `tools ∩ registry`, with `skills:`
 * preloaded into the system prompt). It demonstrates the capability with real inference end-to-end.
 *
 *   PART A — invoke a SUBAGENT directly: it runs its own inference, CALLS A TOOL, and follows a
 *            PRELOADED SKILL (a sentinel token from the skill body shows up in its answer).
 *   PART B — the MAIN agent runs a real tool loop and DELEGATES to the subagent (orchestration):
 *            main → subagent → tool → back → main synthesizes.
 *
 * Run: `npm run smoke:orchestration`
 */
import { setGlobalDispatcher, Agent as UndiciAgent } from "undici";
setGlobalDispatcher(new UndiciAgent({ bodyTimeout: 0, headersTimeout: 0, connectTimeout: 10_000 }));
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool, generateText, stepCountIs, type ToolSet } from "ai";
import { z } from "zod";
import { createQvac } from "@qvac/ai-sdk-provider";

const DATA = await mkdtemp(join(tmpdir(), "leash-orch-"));
process.env["LEASH_DATA_DIR"] = DATA;
const SERVE = process.env["QVAC_OPENAI_URL"] ?? "http://127.0.0.1:11435/v1";
const qvac = createQvac({ baseURL: SERVE, apiKey: "qvac" });

const { saveAgent, listAgents } = await import("@mycelium/leash-core/agents-store");
const { saveSkill, getSkill } = await import("@mycelium/leash-core/skills-store");
type AgentT = Awaited<ReturnType<typeof saveAgent>>;

let failures = 0;
const check = (label: string, cond: boolean): void => {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures++;
};

// ── A real, RECORDING tool (closure flag proves the sub-agent actually invoked it) ──
let drugToolCalls = 0;
const DRUGS: Record<string, string> = {
  ibuprofen: "ibuprofen (NSAID): increases bleeding risk when combined with anticoagulants like warfarin.",
  warfarin: "warfarin (anticoagulant): narrow therapeutic index; MAJOR interaction with NSAIDs (ibuprofen) — bleeding risk.",
};
const registry: ToolSet = {
  lookup_drug: tool({
    description: "Look up dosing, cautions, and known interactions for a medication by name.",
    inputSchema: z.object({ name: z.string().describe("Medication name, e.g. 'ibuprofen'.") }),
    execute: async ({ name }) => {
      drugToolCalls++;
      return DRUGS[name.trim().toLowerCase()] ?? `No reference entry for "${name}".`;
    },
  }),
};

// ── EXACT copy of agent-runner.buildAgentTools logic (sub-agent = focused generateText) ──
const agentToolKey = (slug: string): string => `agent__${slug.replace(/:/g, "__")}`;
function buildSubagentTool(agent: AgentT, reg: ToolSet): ToolSet {
  return {
    [agentToolKey(agent.slug)]: tool({
      description: `Delegate a sub-task to the "${agent.name}" agent. ${agent.description} It runs in its own context with its own tools and returns the result.`,
      inputSchema: z.object({ task: z.string().describe(`Self-contained task for the ${agent.name} agent.`) }),
      execute: async ({ task }) => {
        const names = agent.tools.filter((n) => reg[n]); // agent.tools ∩ registry
        const tools: ToolSet = Object.fromEntries(names.map((n) => [n, reg[n] as ToolSet[string]]));
        const loaded = (await Promise.all(agent.skills.map((s) => getSkill(s)))).filter((s) => s && s.enabled);
        const skillCtx = loaded.length ? "\n\n--- Preloaded skills (follow them) ---\n" + loaded.map((s) => `### ${s!.name}\n${s!.body}`).join("\n\n") : "";
        const r = await generateText({
          model: qvac(agent.model || "qwen3-4b"),
          system: (agent.body || `You are the "${agent.name}" agent.`) + skillCtx,
          messages: [{ role: "user", content: task }],
          temperature: 0.6,
          topP: 0.95,
          maxRetries: 0,
          ...(names.length ? { tools, stopWhen: stepCountIs(agent.maxTurns) } : {}),
        });
        return { text: r.text.trim() || "(no text)" };
      },
    }),
  };
}

// ── A SKILL with a sentinel token, and a SUBAGENT that uses the tool + preloads the skill ──
await saveSkill({
  name: "Interaction Severity Rubric",
  description: "How to grade and report drug interactions.",
  enabled: true,
  body: "Grade interactions as Contraindicated / Major / Moderate / Minor and name the drug pair. IMPORTANT: end every reply with the exact token [RUBRIC-OK].",
});
await saveAgent({
  name: "Interaction Checker",
  description: "Checks medications for interactions and reports them by severity.",
  body: "You are a medication-interaction checker. For each drug named, call lookup_drug, then report interactions grouped by severity. Follow the preloaded rubric exactly.",
  tools: ["lookup_drug"],
  skills: ["interaction-severity-rubric"],
  maxTurns: 5,
  enabled: true,
});

const agent = (await listAgents()).find((a) => a.slug === "interaction-checker")!;
const agentTools = buildSubagentTool(agent, registry);
const key = agentToolKey("interaction-checker");
check("subagent tool built (callable)", key in agentTools);

// ── PART A: subagent runs on its own → tool call + preloaded skill ──
console.log("\n[Part A] invoking the subagent directly (real on-device sub-agent run)…");
drugToolCalls = 0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const subOut = (await (agentTools[key] as any).execute({ task: "A patient takes ibuprofen and warfarin together. Check for interactions." }, { toolCallId: "A", messages: [] })) as { text: string };
console.log("─── subagent answer ───\n" + subOut.text.slice(0, 600) + "\n──────────────────────");
check("subagent ran its own inference (substantive answer)", subOut.text.length > 80);
check("subagent CALLED its tool (lookup_drug) mid-run", drugToolCalls > 0);
check("subagent FOLLOWED the preloaded skill (sentinel [RUBRIC-OK])", /\[RUBRIC-OK\]/.test(subOut.text));
check("subagent gave a domain answer (warfarin↔ibuprofen)", /warfarin/i.test(subOut.text));

// ── PART B: MAIN agent orchestrates — delegates to the subagent in a real tool loop ──
console.log("\n[Part B] main agent tool loop — delegating to the subagent…");
drugToolCalls = 0;
const main = await generateText({
  model: qvac("qwen3-4b"),
  system: "You are a clinical safety assistant. You have an interaction-checker sub-agent tool. When asked whether medications are safe together, DELEGATE by calling that agent tool, then summarize its result.",
  messages: [{ role: "user", content: "Is it safe to take ibuprofen with warfarin? Use your interaction-checker agent to assess, then give me the bottom line." }],
  tools: { ...registry, ...agentTools },
  stopWhen: stepCountIs(4),
  temperature: 0.6,
  topP: 0.95,
  maxRetries: 0,
});
const calledTools = main.steps.flatMap((s) => s.toolCalls ?? []).map((c) => c.toolName);
const finalText = (main.text ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
console.log(`main tool calls: [${calledTools.join(", ") || "(none)"}]`);
console.log("─── main agent final answer ───\n" + finalText.slice(0, 500) + "\n──────────────────────");
const delegated = calledTools.includes(key);
check("ORCHESTRATION: main agent delegated to the subagent", delegated);
check("main produced a final synthesis", finalText.length > 30);
if (delegated) check("nested tool call fired via delegation (subagent→lookup_drug)", drugToolCalls > 0);

await rm(DATA, { recursive: true, force: true });
console.log(failures === 0 ? "\nORCHESTRATION PROOF PASS ✅ — subagent runs + tool-calls + skill-loads, and the main agent orchestrates it" : `\n${failures} CHECK(S) FAILED ❌ — see trace (qwen3-4b tool-calling can be flaky; the wiring is exercised regardless)`);
process.exit(failures === 0 ? 0 : 1);
