/**
 * The market table — every provider this device knows, ranked. The credibility centerpiece:
 * `accountable` (wallet↔key bound + receipts verified on-chain) is the trust column, `effectiveCost`
 * (price ÷ quality) is the value column. Self sits last, tagged "you". Server-rendered.
 */
import type { MarketRow } from "../../lib/leash/economy.ts";
import { fmtMu, fmtScore, shortAddr } from "./format.ts";

const COLS = "minmax(0,1.7fr) 1.2fr 0.85fr 0.95fr 1fr";

function ScoreBar({ score, max }: { score: number; max: number }) {
  const pct = Math.max(2, Math.min(100, (score / (max || 1)) * 100));
  return (
    <span className="inline-flex items-center gap-2" style={{ minWidth: 0 }}>
      <span className="inline-block h-[5px] w-16 overflow-hidden rounded-full" style={{ background: "var(--color-rule)" }}>
        <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: "var(--color-sage)" }} />
      </span>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.74rem", color: "var(--color-ink-soft)" }}>{fmtScore(score)}</span>
    </span>
  );
}

export function EconomyMarket({ market }: { market: MarketRow[] }) {
  if (market.length === 0) {
    return <p className="italic" style={{ color: "var(--color-faint)", fontFamily: "var(--font-body)" }}>No providers seen yet — pair a peer that serves paid inference.</p>;
  }
  const maxScore = Math.max(...market.map((m) => m.score), 0.001);
  return (
    <div>
      <div className="grid items-center gap-3 pb-2" style={{ gridTemplateColumns: COLS, borderBottom: "1px solid var(--color-rule)" }}>
        <span className="kicker" style={{ color: "var(--color-faint)" }}>Provider</span>
        <span className="kicker" style={{ color: "var(--color-faint)" }}>Reputation</span>
        <span className="kicker text-right" style={{ color: "var(--color-faint)" }}>Price/ktok</span>
        <span className="kicker text-right" style={{ color: "var(--color-faint)" }}>Eff. cost</span>
        <span className="kicker text-right" style={{ color: "var(--color-faint)" }}>Accountability</span>
      </div>
      {market.map((m, i) => (
        <div
          key={`${m.providerId}:${m.wallet ?? i}`}
          className="grid items-center gap-3 py-2.5"
          style={{ gridTemplateColumns: COLS, borderBottom: "1px solid var(--color-rule)", opacity: m.isSelf ? 0.72 : 1 }}
        >
          <span className="flex min-w-0 flex-col">
            <span className="flex items-center gap-2" style={{ minWidth: 0 }}>
              <span aria-hidden className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: m.live ? "var(--color-sage)" : "var(--color-faint)" }} />
              <span className="truncate" style={{ fontFamily: "var(--font-body)", color: "var(--color-ink)", fontSize: "0.95rem" }}>{m.displayName}</span>
              {m.isSelf && <span className="kicker shrink-0" style={{ color: "var(--color-sage-deep)" }}>you</span>}
            </span>
            <span className="truncate" style={{ fontFamily: "var(--font-mono)", fontSize: "0.66rem", color: "var(--color-faint)" }}>
              {shortAddr(m.wallet)} · {m.settledCount} settled · {m.distinctPayers} payer{m.distinctPayers === 1 ? "" : "s"}
              {m.unsettledCount > 0 ? ` · ${m.unsettledCount} unsettled` : ""}
            </span>
          </span>
          <ScoreBar score={m.score} max={maxScore} />
          <span className="text-right" style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: "var(--color-ink-soft)" }}>
            {m.pricePerKiloToken == null ? "—" : fmtMu(m.pricePerKiloToken)}
          </span>
          <span className="text-right" style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: m.isSelf ? "var(--color-faint)" : "var(--color-ink)" }}>
            {m.isSelf || m.effectiveCost == null ? "—" : fmtMu(m.effectiveCost)}
          </span>
          <span className="flex items-center justify-end gap-2">
            <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: m.accountable ? "var(--color-sage)" : "var(--color-brick)" }} />
            <span className="kicker" style={{ color: m.accountable ? "var(--color-sage-deep)" : "var(--color-brick)" }}>
              {m.accountable ? "on-chain ✓" : "unverified"}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}
