/**
 * `/brain` — the assistant's configuration surface: Memory (notes + activity browser
 * with real forgetting), Skills (markdown instruction documents), Tools (registry
 * toggles), Prompts (system/voice/medpsy overrides), Models (inventory + lifecycle;
 * serve control lands with P5c).
 */
import Link from "next/link";
import { listSkills } from "../../lib/leash/skills-store.ts";
import { listNotes, activityPage, indexStats } from "../../lib/leash/memory-admin.ts";
import { listMemories } from "../../lib/leash/memories-store.ts";
import { modelsInventory, catalogWithFit, listDownloads } from "../../lib/leash/models.ts";
import { forage } from "../../lib/leash/forage.ts";
import { serveStatus } from "../../lib/leash/serve-control.ts";
import { getPrompts } from "../../lib/leash/prompts-store.ts";
import { disabledTools, askFirstOverrides, DEFAULT_ASK_FIRST } from "../../lib/leash/tool-config.ts";
import { leashTools } from "../../lib/leash/tools.ts";
import { taskTools } from "../../lib/leash/task-tools.ts";
import { memoryTools } from "../../lib/leash/memory-tools.ts";
import { skillTools } from "../../lib/leash/skill-tools.ts";
import { researchTools } from "../../lib/leash/research-tools.ts";
import { leashMcpTools } from "../../lib/leash/mcp.ts";
import { DashShell } from "../../components/dash.tsx";
import { SkillsPanel } from "../../components/SkillsPanel.tsx";
import { ToolsPanel, type ToolRow } from "../../components/ToolsPanel.tsx";
import { PromptsPanel } from "../../components/PromptsPanel.tsx";
import { MemoryPanel } from "../../components/MemoryPanel.tsx";
import { MemoriesSection } from "../../components/MemoriesSection.tsx";
import { ModelsPanel } from "../../components/ModelsPanel.tsx";
import { ForagePanel } from "../../components/ForagePanel.tsx";

export const dynamic = "force-dynamic";

const TABS = ["memory", "skills", "tools", "prompts", "models", "forage"] as const;
type Tab = (typeof TABS)[number];

async function toolRows(): Promise<ToolRow[]> {
  const [mcp, off, ask] = await Promise.all([leashMcpTools(), disabledTools(), askFirstOverrides()]);
  const registry = { ...leashTools, ...taskTools("dashboard"), ...memoryTools("dashboard"), ...skillTools, ...researchTools, ...mcp };
  return Object.entries(registry).map(([name, t]) => ({
    name,
    description: ((t as { description?: string }).description ?? "").slice(0, 240),
    enabled: !off.has(name),
    askFirst: ask[name] ?? DEFAULT_ASK_FIRST.has(name),
    askFirstDefault: DEFAULT_ASK_FIRST.has(name),
  }));
}

export default async function BrainPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
  const raw = one(params["tab"]);
  const tab: Tab = TABS.includes(raw as Tab) ? (raw as Tab) : "memory";
  const offset = Math.max(0, Number(one(params["offset"]) ?? 0) || 0);

  return (
    <DashShell kicker="Leash · Brain" title="Brain" lede="What the assistant knows and how it behaves — memory, skills, tools, prompts.">
      <div className="mb-5 flex gap-2">
        {TABS.map((t) => (
          <Link
            key={t}
            href={t === "memory" ? "/brain" : `/brain?tab=${t}`}
            className="kicker border px-3 py-1.5 transition-opacity hover:opacity-70"
            style={
              tab === t
                ? { background: "var(--color-ink)", color: "var(--color-cream)", borderColor: "var(--color-ink)" }
                : { borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }
            }
            aria-current={tab === t ? "page" : undefined}
          >
            {t[0]?.toUpperCase() + t.slice(1)}
          </Link>
        ))}
      </div>

      {tab === "memory" && (
        <div className="flex flex-col gap-6">
          <MemoriesSection memories={await listMemories()} />
          <MemoryPanel notes={await listNotes()} activity={await activityPage(offset, 50)} stats={await indexStats()} offset={offset} />
        </div>
      )}
      {tab === "skills" && <SkillsPanel skills={await listSkills()} />}
      {tab === "tools" && <ToolsPanel tools={await toolRows()} />}
      {tab === "prompts" && <PromptsPanel prompts={await getPrompts()} />}
      {tab === "models" && (
        <ModelsPanel inventory={await modelsInventory()} serve={await serveStatus()} catalog={await catalogWithFit()} downloads={await listDownloads()} />
      )}
      {tab === "forage" && <ForagePanel result={await forage()} />}
    </DashShell>
  );
}
