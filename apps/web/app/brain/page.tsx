/**
 * `/brain` — the assistant's configuration surface: Memory (notes + activity browser
 * with real forgetting), Skills (markdown instruction documents), Tools (registry
 * toggles), Prompts (system/voice/medpsy overrides), Models (inventory + lifecycle;
 * serve control lands with P5c).
 */
import Link from "next/link";
import { listSkills } from "../../lib/leash/skills-store.ts";
import { listPlugins } from "../../lib/leash/plugins-store.ts";
import { listAgents } from "../../lib/leash/agents-store.ts";
import { listNotes, activityPage, indexStats } from "../../lib/leash/memory-admin.ts";
import { listMemories } from "../../lib/leash/memories-store.ts";
import { modelsInventory, catalogWithFit, listDownloads } from "../../lib/leash/models.ts";
import { forage } from "../../lib/leash/forage.ts";
import { serveStatus } from "../../lib/leash/serve-control.ts";
import { getPrompts } from "../../lib/leash/prompts-store.ts";
import { disabledTools, askFirstOverrides, DEFAULT_ASK_FIRST } from "../../lib/leash/tool-config.ts";
import { leashTools } from "../../lib/leash/tools.ts";
import { COMPUTER_TOOL_NAMES, BASH_TOOL_NAMES, bashScopeNote } from "../../lib/leash/tool-lanes.ts";
import { computerModelInfo } from "../../lib/leash/computer-model.ts";
import { leashMcpTools, mcpServerStatuses, mcpToolIcons } from "../../lib/leash/mcp.ts";
import { DashShell, DashCard, Stat, Row } from "../../components/dash.tsx";
import { buildSeries } from "../../lib/leash/evolve.ts";
import { GrowthChart } from "../../components/GrowthChart.tsx";
import { SkillsPanel } from "../../components/SkillsPanel.tsx";
import { PluginsPanel } from "../../components/PluginsPanel.tsx";
import { AgentsPanel } from "../../components/AgentsPanel.tsx";
import { ToolsPanel, type ToolRow } from "../../components/ToolsPanel.tsx";
import { PromptsPanel } from "../../components/PromptsPanel.tsx";
import { MemoryLanding } from "../../components/MemoryLanding.tsx";
import { ModelsPanel } from "../../components/ModelsPanel.tsx";
import { ForagePanel } from "../../components/ForagePanel.tsx";
import { McpPanel } from "../../components/McpPanel.tsx";
import { ProactivityPanel } from "../../components/ProactivityPanel.tsx";
import { getConstitution } from "../../lib/leash/constitution.ts";
import { loadMainAgentBase } from "../../lib/leash/main-agent.ts";

export const dynamic = "force-dynamic";

const TABS = ["memory", "skills", "plugins", "agents", "tools", "mcp", "prompts", "models", "growth", "forage", "proactivity"] as const;
type Tab = (typeof TABS)[number];

async function toolRows(): Promise<ToolRow[]> {
  const [mcp, off, ask, computerNote, toolIcons] = await Promise.all([leashMcpTools(), disabledTools(), askFirstOverrides(), computerModelInfo(), mcpToolIcons()]);
  // Capability tools (incl. Computer + Files) now arrive via the leash-tools-mcp groups in `mcp`.
  const registry = { ...leashTools, ...mcp };
  const mcpNames = new Set(Object.keys(mcp));
  const bashNote = bashScopeNote();
  return Object.entries(registry).map(([name, t]) => ({
    name,
    description: ((t as { description?: string }).description ?? "").slice(0, 240),
    enabled: !off.has(name),
    askFirst: ask[name] ?? DEFAULT_ASK_FIRST.has(name),
    askFirstDefault: DEFAULT_ASK_FIRST.has(name),
    // The computer-use rows show which model drives them; the bash rows note the sandbox scope.
    ...(COMPUTER_TOOL_NAMES.has(name) ? { infoNote: computerNote } : BASH_TOOL_NAMES.has(name) ? { infoNote: bashNote } : {}),
    // MCP tools get an icon slot; populate the real icon where the server advertised one.
    ...(mcpNames.has(name) ? { mcp: true } : {}),
    ...(toolIcons[name] ? { iconDataUri: toolIcons[name] } : {}),
  }));
}

export default async function BrainPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
  const raw = one(params["tab"]);
  const tab: Tab = TABS.includes(raw as Tab) ? (raw as Tab) : "memory";

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
        <MemoryLanding memories={await listMemories()} notes={await listNotes()} activity={await activityPage(0, 5)} stats={await indexStats()} />
      )}
      {tab === "skills" && <SkillsPanel skills={await listSkills()} />}
      {tab === "plugins" && <PluginsPanel plugins={await listPlugins()} />}
      {tab === "agents" && <AgentsPanel agents={await listAgents()} mainAgent={{ name: loadMainAgentBase().name }} />}
      {tab === "tools" && <ToolsPanel tools={await toolRows()} />}
      {tab === "mcp" && <McpPanel servers={await mcpServerStatuses()} />}
      {tab === "prompts" && <PromptsPanel prompts={await getPrompts()} />}
      {tab === "models" && <ModelsPanel inventory={await modelsInventory()} serve={await serveStatus()} catalog={await catalogWithFit()} downloads={await listDownloads()} />}
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
      {tab === "proactivity" && <ProactivityPanel constitution={await getConstitution()} />}
    </DashShell>
  );
}
