/**
 * `/economy` — the Ledger. The judge-facing view of the device-mesh AI economy: what this device
 * earned serving inference vs what it spent borrowing it, the live provider market (reputation,
 * price, effective cost, on-chain accountability), and its own settlement receipts with tx refs.
 *
 * Reads the daemon's /receipts + /reputation + /peers (server-side, polled by LiveRefresh). The
 * money figures are micro-units of the settlement stablecoin (µUSDT0 on the live Plasma rail).
 */
import { economySnapshot } from "../../lib/leash/economy.server.ts";
import { DashShell, DashCard } from "../../components/dash.tsx";
import { LiveRefresh } from "../../components/LiveRefresh.tsx";
import { Sparkline } from "../../components/economy/Sparkline.tsx";
import { EconomyMarket } from "../../components/economy/EconomyMarket.tsx";
import { EconomyReceipts } from "../../components/economy/EconomyReceipts.tsx";
import { fmtMu, fmtSignedMu, shortAddr } from "../../components/economy/format.ts";

export const dynamic = "force-dynamic";

function Figure({ label, value, color, series, seriesColor, caption }: { label: string; value: string; color: string; series?: number[]; seriesColor?: string; caption?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="kicker" style={{ color: "var(--color-faint)" }}>{label}</span>
      <span style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: "2.3rem", lineHeight: 1, color }}>{value}</span>
      {series ? (
        <Sparkline values={series} color={seriesColor ?? color} />
      ) : (
        <span className="flex items-end" style={{ height: 30, fontFamily: "var(--font-body)", fontStyle: "italic", fontSize: "0.8rem", color: "var(--color-faint)" }}>{caption ?? ""}</span>
      )}
    </div>
  );
}

export default async function EconomyPage() {
  const { snapshot, error } = await economySnapshot();
  const explorerBase = process.env["NEXT_PUBLIC_EXPLORER_BASE"];
  const netColor = snapshot.net >= 0 ? "var(--color-sage-deep)" : "var(--color-brick)";

  return (
    <DashShell
      kicker="Leash · Economy"
      title="Ledger"
      lede="The device-mesh AI economy, in money: what this device earned serving inference, what it spent borrowing it, and who in the market is worth paying."
    >
      <LiveRefresh seconds={5} />
      <div className="flex flex-col gap-5">
        {error && (
          <div className="flex items-center gap-2 border px-4 py-3" style={{ borderColor: "var(--color-brick)", background: "color-mix(in srgb, var(--color-brick) 8%, var(--color-paper))" }}>
            <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: "var(--color-brick)" }} />
            <span style={{ fontFamily: "var(--font-body)", color: "var(--color-ink-soft)" }}>{error}</span>
          </div>
        )}

        {/* Hero — the balance sheet */}
        <section className="border p-5" style={{ borderColor: "var(--color-rule)", background: "var(--color-paper)" }}>
          <div className="grid gap-6 sm:grid-cols-3">
            <Figure label="Earned (provider)" value={fmtMu(snapshot.earned)} color="var(--color-sage-deep)" series={snapshot.earnedSeries} seriesColor="var(--color-sage)" />
            <Figure label="Spent (consumer)" value={fmtMu(snapshot.spent)} color="var(--color-brick)" series={snapshot.spentSeries} seriesColor="var(--color-brick)" />
            <Figure label="Net" value={fmtSignedMu(snapshot.net)} color={netColor} caption={`${snapshot.settledCount} settled · ${snapshot.asset}`} />
          </div>
          <div className="mt-4 border-t pt-3" style={{ borderColor: "var(--color-rule)" }}>
            <span className="kicker" style={{ color: "var(--color-faint)" }}>
              wallet {shortAddr(snapshot.wallet)} · {snapshot.networkId ?? "—"} · settled in {snapshot.asset}
            </span>
          </div>
        </section>

        <DashCard title="Market">
          <EconomyMarket market={snapshot.market} />
        </DashCard>

        <DashCard title="Receipts">
          <EconomyReceipts receipts={snapshot.receipts} {...(explorerBase ? { explorerBase } : {})} />
        </DashCard>
      </div>
    </DashShell>
  );
}
