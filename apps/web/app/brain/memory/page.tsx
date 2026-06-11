import Link from "next/link";
import { ChevronLeftIcon } from "lucide-react";
import { DashShell } from "../../../components/dash.tsx";
import { MemoriesSection } from "../../../components/MemoriesSection.tsx";
import { listMemories } from "../../../lib/leash/memories-store.ts";

export const dynamic = "force-dynamic";

export default async function MemoryPage() {
  return (
    <DashShell kicker="Leash · Brain" title="Memories" lede="The atomic things the assistant knows about you — preferences shape every turn; the rest are recalled on demand.">
      <Link href="/brain" className="kicker mb-4 inline-flex items-center gap-1 transition-opacity hover:opacity-70" style={{ color: "var(--color-muted)" }}>
        <ChevronLeftIcon size={14} /> Brain
      </Link>
      <MemoriesSection memories={await listMemories()} />
    </DashShell>
  );
}
