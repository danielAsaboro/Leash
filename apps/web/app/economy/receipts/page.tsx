/**
 * `/economy/receipts` — the full settlement ledger. The dedicated, filterable, paginated version of the
 * Receipts card on `/economy`: every paid borrow this device settled on the mesh, grouped by day, with
 * the four facet filters and the on-chain tx for each row. Reads the daemon's /receipts (server-side,
 * re-polled by LiveRefresh); the interactive list is the ReceiptsLedger client island.
 */
import Link from "next/link";
import { economySnapshot } from "../../../lib/leash/economy.server.ts";
import { DashShell } from "../../../components/dash.tsx";
import { LiveRefresh } from "../../../components/LiveRefresh.tsx";
import { ReceiptsLedger } from "../../../components/economy/ReceiptsLedger.tsx";

export const dynamic = "force-dynamic";

export default async function ReceiptsPage() {
  const { snapshot, error } = await economySnapshot();
  const explorerBase = process.env["NEXT_PUBLIC_EXPLORER_BASE"];

  return (
    <DashShell
      kicker="Leash · Economy"
      title="Receipts"
      lede="Every paid borrow this device settled on the mesh — earned serving inference, spent borrowing it — grouped by day, with the on-chain tx for each."
    >
      <LiveRefresh seconds={10} />
      <div className="flex flex-col gap-4">
        <Link href="/economy" className="kicker self-start" style={{ color: "var(--color-faint)" }}>← Ledger</Link>

        {error && (
          <div className="flex items-center gap-2 border px-4 py-3" style={{ borderColor: "var(--color-brick)", background: "color-mix(in srgb, var(--color-brick) 8%, var(--color-paper))" }}>
            <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: "var(--color-brick)" }} />
            <span style={{ fontFamily: "var(--font-body)", color: "var(--color-ink-soft)" }}>{error}</span>
          </div>
        )}

        <section className="border p-5" style={{ borderColor: "var(--color-rule)", background: "var(--color-paper)" }}>
          <ReceiptsLedger receipts={snapshot.receipts} asset={snapshot.asset} {...(explorerBase ? { explorerBase } : {})} />
        </section>
      </div>
    </DashShell>
  );
}
