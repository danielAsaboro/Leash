/**
 * `/research` — deep research: start a run, browse the paginated list of runs. Each row opens
 * `/research/<id>` for the live plan→search→read→synthesize loop and the synthesized report.
 * Runs are detached children (survive dev restarts); this page reflects their status files.
 * `?run=<id>` deep links redirect to the new per-run route.
 *
 * Online feature — it gathers live web sources (keyless DuckDuckGo, or SearXNG when
 * LEASH_SEARXNG_URL is set) and synthesizes them on-device via the QVAC serve.
 */
import { redirect } from "next/navigation";
import { listResearch } from "../../lib/leash/research-store.ts";
import { DashShell } from "../../components/dash.tsx";
import { ResearchList } from "../../components/ResearchList.tsx";

export const dynamic = "force-dynamic";

const LIMIT = 20;

export default async function ResearchPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

  const run = one(params["run"]);
  if (run) redirect(`/research/${run}`); // back-compat with old ?run= deep links

  const offset = Math.max(0, Number(one(params["offset"]) ?? 0) || 0);
  const all = await listResearch();
  const total = all.length;
  const pages = Math.max(1, Math.ceil(total / LIMIT));
  const page = Math.min(pages, Math.floor(offset / LIMIT) + 1);
  const slice = all.slice((page - 1) * LIMIT, (page - 1) * LIMIT + LIMIT);

  return (
    <DashShell kicker="Leash · Research" title="Deep Research" lede="Pose a question; the assistant gathers, reads, and synthesizes live web sources into a cited report.">
      <ResearchList runs={slice} page={page} pages={pages} total={total} perPage={LIMIT} />
    </DashShell>
  );
}
