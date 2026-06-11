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
import { computerTools } from "../../lib/leash/computer-tools.ts";
import { computerModelInfo } from "../../lib/leash/computer-model.ts";
import { leashMcpTools, mcpServerStatuses } from "../../lib/leash/mcp.ts";
import { DashShell, DashCard, Stat, Row } from "../../components/dash.tsx";
import { buildSeries } from "../../lib/leash/evolve.ts";
import { GrowthChart } from "../../components/GrowthChart.tsx";
import { SkillsPanel } from "../../components/SkillsPanel.tsx";
import { ToolsPanel, type ToolRow } from "../../components/ToolsPanel.tsx";
import { PromptsPanel } from "../../components/PromptsPanel.tsx";
import { MemoryPanel } from "../../components/MemoryPanel.tsx";
import { MemoriesSection } from "../../components/MemoriesSection.tsx";
import { ModelsPanel } from "../../components/ModelsPanel.tsx";
import { MeshShareCard } from "../../components/MeshShareCard.tsx";
import { ForagePanel } from "../../components/ForagePanel.tsx";
import { McpPanel } from "../../components/McpPanel.tsx";

export const dynamic = "force-dynamic";

const TABS = ["memory", "skills", "tools", "mcp", "prompts", "models", "growth", "forage"] as const;
type Tab = (typeof TABS)[number];

async function toolRows(): Promise<ToolRow[]> {
  const [mcp, off, ask, computerNote] = await Promise.all([leashMcpTools(), disabledTools(), askFirstOverrides(), computerModelInfo()]);
  const registry = { ...leashTools, ...taskTools("dashboard"), ...memoryTools("dashboard"), ...skillTools, ...researchTools, ...computerTools, ...mcp };
  const computerNames = new Set(Object.keys(computerTools));
  return Object.entries(registry).map(([name, t]) => ({
    name,
    description: ((t as { description?: string }).description ?? "").slice(0, 240),
    enabled: !off.has(name),
    askFirst: ask[name] ?? DEFAULT_ASK_FIRST.has(name),
    askFirstDefault: DEFAULT_ASK_FIRST.has(name),
    // The computer-use rows show which model drives them and where it runs (local / mesh peer).
    ...(computerNames.has(name) ? { infoNote: computerNote } : {}),
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
            {t === "mcp" ? "MCP" : t[0]?.toUpperCase() + t.slice(1)}
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
      {tab === "mcp" && <McpPanel servers={await mcpServerStatuses()} />}
      {tab === "prompts" && <PromptsPanel prompts={await getPrompts()} />}
      {tab === "models" && (
        <div className="flex flex-col gap-5">
          <MeshShareCard />
          <ModelsPanel inventory={await modelsInventory()} serve={await serveStatus()} catalog={await catalogWithFit()} downloads={await listDownloads()} />
        </div>
      )}
      {tab === "growth" && (() => {
        const series = buildSeries();
        const { latest, axisDeltas } = series;
        const points = series.points.map((p) => ({ version: p.version, base: p.base, adapter: p.adapter }));
        const fmtDelta = (d: number) => `${d >= 0 ? "+" : ""}${d.toFixed(3)}`;
        const pct = (v: number) => `${Math.round(v * 100)}%`;
        const AXIS_LABEL: Record<string, string> = { recall: "Personal-fact recall", preference: "Preference adherence", style: "Style match" };
        return !series.hasData ? (
          <DashCard title="The Understory">
            <p className="italic" style={{ color: "var(--color-muted)", fontFamily: "var(--font-body)" }}>
              No adapter trained yet. Run <code style={{ fontFamily: "var(--font-mono)" }}>npm run evolve</code> (or wait for the 03:30 nightly job) to curate your signals, fine-tune a LoRA adapter, and score it against the frozen eval set. The first round will appear here.
            </p>
          </DashCard>
        ) : (
          <div className="flex flex-col gap-5">
            {latest && (
              <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
                <Stat label="Overall Δ vs base" value={fmtDelta(latest.evalDelta)} accent={latest.evalDelta >= 0} />
                <Stat label="Training pairs" value={latest.trainPairs} />
                <Stat label="Adapter" value={latest.version} />
                <Stat label="Size" value={`${(latest.sizeBytes / 1e6).toFixed(1)} MB`} />
              </div>
            )}
            <DashCard title="Better at you — base vs adapter"><GrowthChart points={points} /></DashCard>
            {axisDeltas.length > 0 && (
              <DashCard title="Latest adapter — per axis">
                {axisDeltas.map((a) => (
                  <Row key={a.axis} label={AXIS_LABEL[a.axis] ?? a.axis} value={<span>{pct(a.base)} → <strong style={{ color: a.delta >= 0 ? "var(--color-sage-deep)" : "var(--color-brick)" }}>{pct(a.adapter)}</strong> ({fmtDelta(a.delta)})</span>} />
                ))}
              </DashCard>
            )}
            {latest && (
              <DashCard title="Adapter manifest">
                <Row label="Version" value={latest.version} />
                <Row label="Base model" value={latest.baseModel} />
                <Row label="Trained on" value={`${latest.trainPairs} pairs`} />
                <Row label="eval Δ (overall)" value={<span style={{ color: latest.evalDelta >= 0 ? "var(--color-sage-deep)" : "var(--color-brick)" }}>{fmtDelta(latest.evalDelta)}</span>} />
                <Row label="Promotable" value={latest.evalDelta >= 0 ? "yes — clears the bar" : "no — regression, not promoted"} />
                <Row label="sha256" value={latest.sha256.slice(0, 16) + "…"} />
                <Row label="Created" value={new Date(latest.createdAt).toLocaleString()} />
              </DashCard>
            )}
          </div>
        );
      })()}
      {tab === "forage" && <ForagePanel result={await forage()} />}
    </DashShell>
  );
}
