/**
 * `/research` — deep research: start a run, watch the plan→search→read→synthesize loop
 * live, read the synthesized report. Runs are detached children (survive dev restarts);
 * this page reflects their status/report files. `?run=<id>` selects a report.
 *
 * Online feature — it gathers live web sources (keyless DuckDuckGo, or SearXNG when
 * LEASH_SEARXNG_URL is set) and synthesizes them on-device via the QVAC serve.
 */
import { listResearch, researchReport } from "../../lib/leash/research-store.ts";
import { DashShell } from "../../components/dash.tsx";
import { ResearchPanel } from "../../components/ResearchPanel.tsx";

export const dynamic = "force-dynamic";

export default async function ResearchPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const runId = Array.isArray(params["run"]) ? params["run"][0] : params["run"];
  const runs = await listResearch();
  // Default to the newest finished run if none selected.
  const selected = runId ?? runs.find((r) => r.state === "done")?.id;
  const md = selected ? await researchReport(selected) : null;
  const report = selected && md ? { md, id: selected } : null;

  return (
    <DashShell kicker="Leash · Research" title="Deep Research" lede="Pose a question; the assistant gathers, reads, and synthesizes live web sources into a cited report.">
      <ResearchPanel runs={runs} report={report} />
    </DashShell>
  );
}
