import Link from "next/link";
import { ChevronLeftIcon } from "lucide-react";
import { DashShell } from "../../../components/dash.tsx";
import { NotesSection } from "../../../components/NotesSection.tsx";
import { listNotes } from "../../../lib/leash/memory-admin.ts";

export const dynamic = "force-dynamic";

export default async function NotesPage() {
  return (
    <DashShell kicker="Leash · Brain" title="Local context" lede="Legacy file-backed context indexed by the assistant. Apple Notes is connected through MCP, not this folder.">
      <Link href="/brain" className="kicker mb-4 inline-flex items-center gap-1 transition-opacity hover:opacity-70" style={{ color: "var(--color-muted)" }}>
        <ChevronLeftIcon size={14} /> Brain
      </Link>
      <NotesSection notes={await listNotes()} />
    </DashShell>
  );
}
