/**
 * Pure view logic for the full receipts ledger (/economy/receipts): derive a modality from a model
 * alias, filter by the four facets, group into calendar-day sections with a per-day net subtotal, and
 * paginate by whole day-groups (a day is never split across pages — bank-statement style). No React, so
 * it's unit-tested by receipt-view.smoke.ts.
 */
import type { LedgerReceipt } from "../../lib/leash/economy.ts";

export type Modality = "chat" | "vision" | "embed" | "stt" | "tts";
export type FlowFilter = "all" | "earn" | "spend";
export type StatusFilter = "all" | "settled" | "retrying";

export interface ReceiptFilters {
  flow: FlowFilter;
  status: StatusFilter;
  /** A counterparty key, or "all". */
  peer: string;
  /** A {@link Modality}, or "all". */
  modality: string;
}

export const EMPTY_FILTERS: ReceiptFilters = { flow: "all", status: "all", peer: "all", modality: "all" };

/** Best-effort modality from a model alias (the receipt only carries the alias). Defaults to chat. */
export function modalityOf(alias: string): Modality {
  const a = alias.toLowerCase();
  if (/(^|[^a-z])vl|vision|llava|qwen.*-?v|moondream/.test(a)) return "vision";
  if (/gte|embed|bge|e5|minilm|nomic/.test(a)) return "embed";
  if (/parakeet|whisper|\bstt\b|transcrib|asr/.test(a)) return "stt";
  if (/supertonic|\btts\b|speech|bark|piper|kokoro/.test(a)) return "tts";
  return "chat";
}

/** Signed amount in the ledger's sense: earn is positive, spend negative, other zero. */
export function signedAmount(r: Pick<LedgerReceipt, "direction" | "amount">): number {
  return r.direction === "earn" ? r.amount : r.direction === "spend" ? -r.amount : 0;
}

export function filterReceipts(receipts: readonly LedgerReceipt[], f: ReceiptFilters): LedgerReceipt[] {
  return receipts.filter((r) => {
    if (f.flow !== "all" && r.direction !== f.flow) return false;
    if (f.status !== "all" && r.status !== f.status) return false;
    if (f.peer !== "all" && r.counterparty !== f.peer) return false;
    if (f.modality !== "all" && modalityOf(r.alias) !== f.modality) return false;
    return true;
  });
}

export interface DayGroup {
  /** YYYY-MM-DD. */
  day: string;
  receipts: LedgerReceipt[];
  /** Net (signed) across the day. */
  net: number;
}

/** Group receipts into calendar-day sections, newest day first, rows within a day newest first. */
export function groupByDay(receipts: readonly LedgerReceipt[]): DayGroup[] {
  const sorted = [...receipts].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const order: string[] = [];
  const byDay = new Map<string, LedgerReceipt[]>();
  for (const r of sorted) {
    const day = (r.at || "").slice(0, 10);
    let bucket = byDay.get(day);
    if (!bucket) { bucket = []; byDay.set(day, bucket); order.push(day); }
    bucket.push(r);
  }
  return order.map((day) => {
    const rs = byDay.get(day)!;
    return { day, receipts: rs, net: rs.reduce((s, r) => s + signedAmount(r), 0) };
  });
}

/** Split day-groups into pages of ~pageSize ROWS, never splitting a day (a lone huge day gets its own page). */
export function paginateDays(groups: readonly DayGroup[], pageSize: number): DayGroup[][] {
  const pages: DayGroup[][] = [];
  let cur: DayGroup[] = [];
  let count = 0;
  for (const g of groups) {
    if (count > 0 && count + g.receipts.length > pageSize) { pages.push(cur); cur = []; count = 0; }
    cur.push(g);
    count += g.receipts.length;
  }
  if (cur.length > 0) pages.push(cur);
  return pages;
}

/** The distinct counterparties present, for the peer filter. */
export function peersIn(receipts: readonly LedgerReceipt[]): string[] {
  return [...new Set(receipts.map((r) => r.counterparty).filter(Boolean))];
}

/** The distinct modalities present, for the modality filter. */
export function modalitiesIn(receipts: readonly LedgerReceipt[]): Modality[] {
  const order: Modality[] = ["chat", "vision", "embed", "stt", "tts"];
  const present = new Set(receipts.map((r) => modalityOf(r.alias)));
  return order.filter((m) => present.has(m));
}
