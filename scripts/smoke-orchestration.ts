/**
 * LIVE multi-agent orchestration proof (needs `qvac serve`) — the eval-critical capability
 * ("multi-agent workflows with orchestration and tool calling") on real on-device chat, using
 * the EXACT AI SDK streaming-subagent pattern the production agent-runner.ts now uses.
 *
 * FIDELITY NOTE: the production runner can't be imported under tsx (web modules load as CJS;
 * @qvac/ai-sdk-provider ships only an ESM export; the real path runs in Next+auth). So this mirrors
 * agent-runner.buildOne EXACTLY — a `ToolLoopAgent` subagent behind a `tool()` whose `async function*`
 * execute streams via `readUIMessageStream(result.toUIMessageStream())` and whose `toModelOutput`
 * trims to the final summary — on the real model + real stores.
 *
 *   PART A — invoke the subagent tool: it STREAMS UIMessages (UI-renderable progress), runs its own
 *            ToolLoopAgent inference, CALLS a tool (visible as a tool part in the transcript), and
 *            follows a PRELOADED skill (sentinel token).
 *   PART B — the MAIN agent delegates to the subagent (orchestration): main → subagent → tool → summary.
 *
 * Run: `npm run smoke:orchestration`
 */
import { setGlobalDispatcher, Agent as UndiciAgent } from "undici";
setGlobalDispatcher(new UndiciAgent({ bodyTimeout: 0, headersTimeout: 0, connectTimeout: 10_000 }));
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool, ToolLoopAgent, generateText, stepCountIs, readUIMessageStream, type ToolSet, type UIMessage } from "ai";
import { z } from "zod";
import { createQvac } from "@qvac/ai-sdk-provider";

const DATA = await mkdtemp(join(tmpdir(), "leash-orch-"));
process.env["LEASH_DATA_DIR"] = DATA;
const qvac = createQvac({ baseURL: process.env["QVAC_OPENAI_URL"] ?? "http://127.0.0.1:11435/v1", apiKey: "qvac" });
const CHAT = process.env["EVAL_CHAT_MODEL"] ?? "chat"; // override to match the loaded serve alias

const { saveAgent, listAgents } = await import("@mycelium/leash-core/agents-store");
const { saveSkill, getSkill } = await import("@mycelium/leash-core/skills-store");
type AgentT = Awaited<ReturnType<typeof saveAgent>>;

let failures = 0;
const check = (label: string, cond: boolean): void => {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures++;
};

// ── A real, RECORDING tool (closure flag proves the sub-agent invoked it) ──
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

const finalText = (m: UIMessage | undefined): string => {
  const parts = m?.parts ?? [];
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i] as { type?: string; text?: unknown };
    if (p?.type === "text" && typeof p.text === "string") return p.text.trim();
  }
  return "";
};

// ── EXACT mirror of agent-runner.buildOne: a streaming ToolLoopAgent behind a tool() ──
const agentToolKey = (slug: string): string => `agent__${slug.replace(/:/g, "__")}`;
function buildSubagentTool(agent: AgentT, reg: ToolSet): ToolSet {
  return {
    [agentToolKey(agent.slug)]: tool({
      description: `Delegate a sub-task to the "${agent.name}" agent. ${agent.description}`,
      inputSchema: z.object({ task: z.string().describe(`Self-contained task for the ${agent.name} agent.`) }),
      execute: async function* ({ task }) {
        const names = agent.tools.filter((n) => reg[n]);
        const tools: ToolSet = Object.fromEntries(names.map((n) => [n, reg[n] as ToolSet[string]]));
        const loaded = (await Promise.all(agent.skills.map((s) => getSkill(s)))).filter((s) => s && s.enabled);
        const skillCtx = loaded.length ? "\n\n--- Preloaded skills (follow them) ---\n" + loaded.map((s) => `### ${s!.name}\n${s!.body}`).join("\n\n") : "";
        const sub = new ToolLoopAgent({
          model: qvac(agent.model || CHAT),
          instructions: (agent.body || `You are the "${agent.name}" agent.`) + skillCtx,
          temperature: 0.6,
          topP: 0.95,
          maxRetries: 0,
          ...(names.length ? { tools, stopWhen: stepCountIs(agent.maxTurns) } : {}),
        });
        const result = await sub.stream({ prompt: task });
        for await (const message of readUIMessageStream({ stream: result.toUIMessageStream() })) yield message;
      },
      toModelOutput: ({ output }) => ({ type: "text", value: finalText(output as UIMessage | undefined) || "(no text)" }),
    }),
  };
}

await saveSkill({
  slug: "interaction-severity-rubric",
  name: "interaction-severity-rubric",
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

// ── PART A: stream the subagent → UI-renderable progress + tool call + preloaded skill ──
console.log("\n[Part A] streaming the subagent (ToolLoopAgent + readUIMessageStream)…");
drugToolCalls = 0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const gen = (agentTools[key] as any).execute({ task: "A patient takes ibuprofen and warfarin together. Check for interactions." }, { toolCallId: "A", messages: [] }) as AsyncIterable<UIMessage>;
let last: UIMessage | undefined;
let yields = 0;
for await (const m of gen) {
  last = m;
  yields++;
}
const text = finalText(last);
const hasToolPart = (last?.parts ?? []).some((p) => typeof (p as { type?: string }).type === "string" && ((p as { type: string }).type.startsWith("tool-") || (p as { type: string }).type === "dynamic-tool"));
console.log(`streamed ${yields} UIMessage update(s); transcript parts: [${(last?.parts ?? []).map((p) => (p as { type?: string }).type).join(", ")}]`);
console.log("─── subagent final text ───\n" + text.slice(0, 500) + "\n──────────────────────");
check("subagent STREAMED UI-renderable progress (≥1 UIMessage update)", yields >= 1);
check("subagent transcript contains the tool call (renderable nested part)", hasToolPart);
check("subagent CALLED its tool (lookup_drug) mid-run", drugToolCalls > 0);
check("subagent FOLLOWED the preloaded skill (sentinel [RUBRIC-OK])", /\[RUBRIC-OK\]/.test(text));
check("subagent gave a domain answer (warfarin)", /warfarin/i.test(text));

// ── PART B: MAIN agent delegates to the subagent (orchestration); toModelOutput trims its view ──
console.log("\n[Part B] main agent delegating to the subagent…");
drugToolCalls = 0;
const main = await generateText({
  model: qvac(CHAT),
  system: "You are a clinical safety assistant. You have an interaction-checker sub-agent tool. When asked whether medications are safe together, DELEGATE by calling that agent tool, then summarize its result.",
  messages: [{ role: "user", content: "Is it safe to take ibuprofen with warfarin? Use your interaction-checker agent to assess, then give me the bottom line." }],
  tools: { ...registry, ...agentTools },
  stopWhen: stepCountIs(4),
  temperature: 0.6,
  topP: 0.95,
  maxRetries: 0,
});
const calledTools = main.steps.flatMap((s) => s.toolCalls ?? []).map((c) => c.toolName);
const mainText = (main.text ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
console.log(`main tool calls: [${calledTools.join(", ") || "(none)"}]`);
console.log("─── main final answer ───\n" + mainText.slice(0, 400) + "\n──────────────────────");
const delegated = calledTools.includes(key);
check("ORCHESTRATION: main agent delegated to the subagent", delegated);
check("main produced a final synthesis", mainText.length > 30);
if (delegated) check("nested tool call fired via delegation (subagent→lookup_drug)", drugToolCalls > 0);

await rm(DATA, { recursive: true, force: true });
console.log(failures === 0 ? "\nORCHESTRATION PROOF PASS ✅ — AI SDK ToolLoopAgent subagent: streams to UI, calls tools, loads skills, and the main agent orchestrates it" : `\n${failures} CHECK(S) FAILED ❌ — see trace (chat tool-calling can be flaky; the SDK wiring is exercised regardless)`);
process.exit(failures === 0 ? 0 : 1);
