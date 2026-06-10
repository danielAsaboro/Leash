/**
 * This device's settlement receipts — its own ledger. Each row is a paid delegated completion:
 * which way the money flowed (earn ↑ / spend ↓), the model, tokens, amount, settle status, and the
 * on-chain tx. Server-rendered; the tx chip is the only client island (copy / explorer link).
 */
import type { LedgerReceipt } from "../../lib/leash/economy.ts";
import { fmtMu, shortAddr } from "./format.ts";
import { TxRef } from "./TxRef.tsx";

const COLS = "0.8fr minmax(0,1.3fr) 0.7fr 0.9fr 0.9fr 1fr";
const CAP = 40;

function FlowTag({ d }: { d: LedgerReceipt["direction"] }) {
  if (d === "earn") return <span className="kicker" style={{ color: "var(--color-sage-deep)" }}>↑ earn</span>;
  if (d === "spend") return <span className="kicker" style={{ color: "var(--color-brick)" }}>↓ spend</span>;
  return <span className="kicker" style={{ color: "var(--color-faint)" }}>·</span>;
}

function StatusTag({ status }: { status: string }) {
  const settled = status === "settled";
  const color = settled ? "var(--color-sage)" : status === "retrying" ? "var(--color-brick)" : "var(--color-faint)";
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />
      <span className="kicker" style={{ color: "var(--color-ink-soft)" }}>{status}</span>
    </span>
  );
}

export function EconomyReceipts({ receipts, explorerBase }: { receipts: LedgerReceipt[]; explorerBase?: string }) {
  if (receipts.length === 0) {
    return <p className="italic" style={{ color: "var(--color-faint)", fontFamily: "var(--font-body)" }}>No receipts yet — this device hasn’t earned or spent on the mesh.</p>;
  }
  const shown = receipts.slice(0, CAP);
  return (
    <div>
      <div className="grid items-center gap-3 pb-2" style={{ gridTemplateColumns: COLS, borderBottom: "1px solid var(--color-rule)" }}>
        {["Flow", "Model · peer", "Tokens", "Amount", "Status", "Tx"].map((h, i) => (
          <span key={h} className={`kicker ${i >= 2 && i <= 3 ? "text-right" : ""}`} style={{ color: "var(--color-faint)" }}>{h}</span>
        ))}
      </div>
      {shown.map((r) => (
        <div key={r.sessionId} className="grid items-center gap-3 py-2.5" style={{ gridTemplateColumns: COLS, borderBottom: "1px solid var(--color-rule)" }}>
          <FlowTag d={r.direction} />
          <span className="flex min-w-0 flex-col">
            <span className="truncate" style={{ fontFamily: "var(--font-body)", color: "var(--color-ink)", fontSize: "0.9rem" }}>{r.alias}</span>
            <span className="truncate" style={{ fontFamily: "var(--font-mono)", fontSize: "0.66rem", color: "var(--color-faint)" }}>{shortAddr(r.counterparty)}</span>
          </span>
          <span className="text-right" style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: "var(--color-ink-soft)" }}>{r.tokens.toLocaleString("en-US")}</span>
          <span className="text-right" style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: r.direction === "spend" ? "var(--color-brick)" : "var(--color-sage-deep)" }}>
            {r.direction === "spend" ? "−" : "+"}{fmtMu(r.amount)}
          </span>
          <StatusTag status={r.status} />
          <span className="min-w-0 truncate"><TxRef hash={r.txHash} {...(explorerBase ? { explorerBase } : {})} /></span>
        </div>
      ))}
      {receipts.length > CAP && (
        <p className="kicker pt-3" style={{ color: "var(--color-faint)" }}>Showing the {CAP} most recent of {receipts.length} receipts.</p>
      )}
    </div>
  );
}
