/**
 * `/research/[id]` — one research run's detail: the live synapse, meta, and the synthesized
 * report. Reads the run's status + report files; `ResearchDetail` polls itself while active.
 */
import { notFound } from "next/navigation";
import { researchStatus, researchReport } from "../../../../lib/leash/research-store.ts";
import { DashShell } from "../../../../components/dash.tsx";
import { ResearchDetail } from "../../../../components/ResearchDetail.tsx";

export const dynamic = "force-dynamic";

export default async function ResearchRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await researchStatus(id);
  if (!run) notFound();
  const report = await researchReport(id);
  return (
    <DashShell kicker="Leash · Research" title="Research run" lede={run.question}>
      <ResearchDetail run={run} report={report} />
    </DashShell>
  );
}
