/**
 * Multi-step loop probe (diagnostic, throwaway-friendly) — drives the REAL Leash agent the
 * same way `POST /api/leash/chat` does (same registry, run_skill, skill matching, callOptions),
 * for ONE prompt, with LEASH_DEBUG_LOOP forced on. It prints the per-step loop-diagnostic lines
 * (from loop-diagnostics.ts) plus a final summary so we can classify the "stops after one step"
 * failure (A finish_reason bug / B overthinking-overwrite / C Implicit Action Failure).
 *
 * Run:  LEASH_DEBUG_LOOP=1 npx tsx apps/web/scripts/loop-probe.mts "your multi-step prompt"
 * It does NOT persist anything; it just exercises the model+middleware+tools+loop.
 */
process.env["LEASH_DEBUG_LOOP"] = process.env["LEASH_DEBUG_LOOP"] ?? "1";

import { CHAT_MODEL } from "../lib/leash/provider.ts";
import { buildLeashAgent, type LeashCallOptions } from "../lib/leash/agent.ts";
import { leashTools } from "../lib/leash/tools.ts";
import { skillsSystemSection, activeSkillsSection } from "../lib/leash/skill-tools.ts";
import { buildSkillRunner } from "../lib/leash/skill-runner.ts";
import { leashMcpTools } from "../lib/leash/mcp.ts";
import { getPrompt } from "../lib/leash/prompts-store.ts";
import { filterEnabledTools, withApprovalGates } from "../lib/leash/tool-config.ts";
import { convertToModelMessages } from "ai";
import type { LeashUIMessage } from "../lib/leash/types.ts";

const SKILL_TOOL_STEPS = 12;

async function main() {
  const prompt = process.argv.slice(2).join(" ").trim() || "Research the best smart light bulbs of 2026 with sources, then create a task to compare the top two options.";
  const id = "loop-probe";

  const baseTools = { ...leashTools, ...(await leashMcpTools()) };
  const tools = { ...baseTools, ...buildSkillRunner(baseTools) };
  const enabledTools = withApprovalGates(await filterEnabledTools(tools));

  const [systemPrompt, skillsSection, activeSkills] = await Promise.all([getPrompt("chat"), skillsSystemSection(), activeSkillsSection(prompt)]);
  const declaredSkillTools = activeSkills?.tools ?? [];
  const system = [systemPrompt, activeSkills?.section ?? "", skillsSection].filter(Boolean).join(" ");

  console.log(`\n=== loop-probe ===\nmodel=${CHAT_MODEL}\nprompt=${JSON.stringify(prompt)}`);
  console.log(`active skill=${activeSkills?.skills.map((s) => s.slug).join(", ") || "(none)"}  declaredSkillTools=[${declaredSkillTools.join(", ")}]`);
  console.log(`steps budget=${SKILL_TOOL_STEPS}\n--- per-step loop diagnostics (leash[loop]) ---`);

  const agent = buildLeashAgent(enabledTools);
  const callOptions: LeashCallOptions = {
    route: "chat",
    steps: SKILL_TOOL_STEPS,
    maxOutputTokens: 2500,
    ...(declaredSkillTools.length ? { skillTools: declaredSkillTools } : {}),
    thinking: true,
    system,
  };

  const messages = await convertToModelMessages([{ role: "user", parts: [{ type: "text", text: prompt }] }] as unknown as LeashUIMessage[]);
  const result = await agent.stream({ messages, options: callOptions });
  await result.consumeStream();

  const steps = await result.steps;
  const finalText = (await result.text)?.trim() ?? "";
  const toolCalls = steps.flatMap((s) => s.toolCalls ?? []);
  console.log(`\n--- summary ---`);
  console.log(`total steps=${steps.length}`);
  console.log(`tool calls (${toolCalls.length}): ${toolCalls.map((c) => c.toolName).join(" → ") || "(none)"}`);
  steps.forEach((s, i) => {
    const names = (s.toolCalls ?? []).map((c) => c.toolName).join(", ") || "(none)";
    console.log(`  step ${i + 1}: finishReason=${s.finishReason} toolCalls=[${names}] textLen=${(s.text ?? "").length}`);
  });
  console.log(`\nfinal answer (${finalText.length} chars):\n${finalText.slice(0, 800)}${finalText.length > 800 ? " …[truncated]" : ""}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("loop-probe failed:", e);
  process.exit(1);
});
