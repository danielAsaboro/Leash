import Link from "next/link";
import { ChevronLeftIcon } from "lucide-react";
import { DashShell } from "../../../components/dash.tsx";
import { ScreenActivitySection } from "../../../components/ScreenActivitySection.tsx";
import { activityPage } from "../../../lib/leash/memory-admin.ts";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export default async function ScreenActivityPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
  const offset = Math.max(0, Number(one(params["offset"]) ?? 0) || 0);

  return (
    <DashShell kicker="Leash · Brain" title="Screen activity" lede="What the watcher has seen on screen — ~2-min observations the assistant can recall. Forgetting one tombstones it.">
      <Link href="/brain" className="kicker mb-4 inline-flex items-center gap-1 transition-opacity hover:opacity-70" style={{ color: "var(--color-muted)" }}>
        <ChevronLeftIcon size={14} /> Brain
      </Link>
      <ScreenActivitySection activity={await activityPage(offset, PAGE_SIZE)} offset={offset} pageSize={PAGE_SIZE} />
    </DashShell>
  );
}
