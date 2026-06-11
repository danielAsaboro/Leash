/**
 * The full receipts ledger (/economy/receipts) — the dedicated page version of the /economy Receipts
 * card. Client island: filter chips (flow + status + modality + peer), calendar-day sections with a
 * per-day net subtotal (bank-statement style), and page-number pagination that never splits a day. The
 * row layout + tokens match {@link EconomyReceipts}; the only data work is the pure helpers in
 * receipt-view.ts.
 */
"use client";
import { useMemo, useState, type ReactNode } from "react";
import type { LedgerReceipt } from "../../lib/leash/economy.ts";
import { filterReceipts, groupByDay, paginateDays, peersIn, modalitiesIn, signedAmount, EMPTY_FILTERS, type ReceiptFilters, type Modality } from "./receipt-view.ts";
import { fmtMu, fmtSignedMu, shortAddr } from "./format.ts";
import { TxRef } from "./TxRef.tsx";

const COLS = "0.7fr minmax(0,1.3fr) 0.7fr 0.85fr 0.85fr 0.95fr";
const PAGE_SIZE = 40;
const MOD_LABEL: Record<Modality, string> = { chat: "chat", vision: "vision", embed: "embed", stt: "stt", tts: "tts" };

function dayLabel(day: string): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(day + "T00:00:00");
  const diff = Math.round((today.getTime() - d.getTime()) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function Chip({ active, onClick, accent, children }: { active: boolean; onClick: () => void; accent?: string; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="kicker px-2.5 py-1 border transition-colors"
      style={{
        borderColor: active ? accent ?? "var(--color-ink)" : "var(--color-rule)",
        background: active ? accent ?? "var(--color-ink)" : "transparent",
        color: active ? "var(--color-paper)" : "var(--color-ink-soft)",
      }}
    >
      {children}
    </button>
  );
}

function FlowTag({ d }: { d: LedgerReceipt["direction"] }) {
  if (d === "earn") return <span className="kicker" style={{ color: "var(--color-sage-deep)" }}>↑ earn</span>;
  if (d === "spend") return <span className="kicker" style={{ color: "var(--color-brick)" }}>↓ spend</span>;
  return <span className="kicker" style={{ color: "var(--color-faint)" }}>·</span>;
}

function StatusTag({ status }: { status: string }) {
  const color = status === "settled" ? "var(--color-sage)" : status === "retrying" ? "var(--color-brick)" : "var(--color-faint)";
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />
      <span className="kicker" style={{ color: "var(--color-ink-soft)" }}>{status}</span>
    </span>
  );
}

export function ReceiptsLedger({ receipts, asset, explorerBase }: { receipts: LedgerReceipt[]; asset: string; explorerBase?: string }) {
  const [f, setF] = useState<ReceiptFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(0);
  const set = (patch: Partial<ReceiptFilters>) => { setF((p) => ({ ...p, ...patch })); setPage(0); };

  const peers = useMemo(() => peersIn(receipts), [receipts]);
  const modalities = useMemo(() => modalitiesIn(receipts), [receipts]);
  const filtered = useMemo(() => filterReceipts(receipts, f), [receipts, f]);
  const pages = useMemo(() => paginateDays(groupByDay(filtered), PAGE_SIZE), [filtered]);
  const cur = Math.min(page, Math.max(0, pages.length - 1));
  const groups = pages[cur] ?? [];
  const net = useMemo(() => filtered.reduce((s, r) => s + signedAmount(r), 0), [filtered]);

  if (receipts.length === 0) {
    return <p className="italic" style={{ color: "var(--color-faint)", fontFamily: "var(--font-body)" }}>No receipts yet — this device hasn’t earned or spent on the mesh.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {/* ── filter chips ─────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="kicker pr-1" style={{ color: "var(--color-faint)" }}>flow</span>
          <Chip active={f.flow === "all"} onClick={() => set({ flow: "all" })}>all</Chip>
          <Chip active={f.flow === "earn"} onClick={() => set({ flow: "earn" })} accent="var(--color-sage-deep)">↑ earned</Chip>
          <Chip active={f.flow === "spend"} onClick={() => set({ flow: "spend" })} accent="var(--color-brick)">↓ spent</Chip>
          <span className="kicker pl-3 pr-1" style={{ color: "var(--color-faint)" }}>status</span>
          <Chip active={f.status === "all"} onClick={() => set({ status: "all" })}>all</Chip>
          <Chip active={f.status === "settled"} onClick={() => set({ status: "settled" })} accent="var(--color-sage-deep)">settled</Chip>
          <Chip active={f.status === "retrying"} onClick={() => set({ status: "retrying" })} accent="var(--color-brick)">retrying</Chip>
        </div>
        {(modalities.length > 1 || peers.length > 1) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {modalities.length > 1 && (
              <>
                <span className="kicker pr-1" style={{ color: "var(--color-faint)" }}>modality</span>
                <Chip active={f.modality === "all"} onClick={() => set({ modality: "all" })}>all</Chip>
                {modalities.map((m) => <Chip key={m} active={f.modality === m} onClick={() => set({ modality: m })}>{MOD_LABEL[m]}</Chip>)}
              </>
            )}
            {peers.length > 1 && (
              <>
                <span className="kicker pl-3 pr-1" style={{ color: "var(--color-faint)" }}>peer</span>
                <Chip active={f.peer === "all"} onClick={() => set({ peer: "all" })}>all</Chip>
                {peers.map((p) => <Chip key={p} active={f.peer === p} onClick={() => set({ peer: p })}>{shortAddr(p)}</Chip>)}
              </>
            )}
          </div>
        )}
      </div>

      {/* ── filtered summary ─────────────────────────────────────────── */}
      <div className="flex items-baseline justify-between border-b pb-1.5" style={{ borderColor: "var(--color-rule)" }}>
        <span className="kicker" style={{ color: "var(--color-faint)" }}>{filtered.length} receipt{filtered.length === 1 ? "" : "s"}</span>
        <span className="kicker" style={{ color: net >= 0 ? "var(--color-sage-deep)" : "var(--color-brick)" }}>net {fmtSignedMu(net)} {asset}</span>
      </div>

      {/* ── grouped rows ─────────────────────────────────────────────── */}
      {filtered.length === 0 ? (
        <p className="italic py-6 text-center" style={{ color: "var(--color-faint)", fontFamily: "var(--font-body)" }}>No receipts match these filters.</p>
      ) : (
        <div className="flex flex-col gap-5">
          {groups.map((g) => (
            <div key={g.day}>
              <div className="flex items-baseline justify-between pb-1">
                <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "0.95rem", color: "var(--color-ink)" }}>{dayLabel(g.day)}</span>
                <span className="kicker" style={{ color: g.net >= 0 ? "var(--color-sage-deep)" : "var(--color-brick)" }}>net {fmtSignedMu(g.net)}</span>
              </div>
              {g.receipts.map((r) => (
                <div key={r.sessionId} className="grid items-center gap-3 py-2.5" style={{ gridTemplateColumns: COLS, borderTop: "1px solid var(--color-rule)" }}>
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
            </div>
          ))}
        </div>
      )}

      {/* ── pagination ───────────────────────────────────────────────── */}
      {pages.length > 1 && (
        <div className="flex flex-wrap items-center justify-center gap-1.5 pt-2">
          <button disabled={cur === 0} onClick={() => setPage(cur - 1)} className="kicker px-2 py-1 border disabled:opacity-30" style={{ borderColor: "var(--color-rule)", color: "var(--color-ink-soft)" }}>← prev</button>
          {pages.map((_, i) => (
            <button key={i} onClick={() => setPage(i)} className="kicker px-2 py-1 border" style={{ borderColor: i === cur ? "var(--color-ink)" : "var(--color-rule)", background: i === cur ? "var(--color-ink)" : "transparent", color: i === cur ? "var(--color-paper)" : "var(--color-ink-soft)" }}>{i + 1}</button>
          ))}
          <button disabled={cur === pages.length - 1} onClick={() => setPage(cur + 1)} className="kicker px-2 py-1 border disabled:opacity-30" style={{ borderColor: "var(--color-rule)", color: "var(--color-ink-soft)" }}>next →</button>
        </div>
      )}
    </div>
  );
}
