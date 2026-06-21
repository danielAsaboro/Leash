/**
 * Pure smoke for the receipts-ledger view logic (apps/web/components/economy/receipt-view.ts):
 * modality derivation, the four filter facets, day grouping with per-day net, and day-aware pagination.
 *
 *   npm run smoke:receipt-view
 */
import assert from "node:assert/strict";
import { modalityOf, filterReceipts, groupByDay, paginateDays, peersIn, modalitiesIn, EMPTY_FILTERS } from "../apps/web/components/economy/receipt-view.ts";

type R = { sessionId: string; alias: string; tokens: number; amount: number; asset: string; txHash: string; status: string; direction: "earn" | "spend" | "other"; counterparty: string; at: string };
const r = (o: Partial<R>): R => ({ sessionId: Math.random().toString(36).slice(2), alias: "chat", tokens: 10, amount: 10, asset: "USDT0", txHash: "0x" + "a".repeat(8), status: "settled", direction: "spend", counterparty: "Pro", at: "2026-06-11T10:00:00Z", ...o });

function main(): void {
  // 1. modalityOf — known aliases on the fleet + the chat default.
  assert.equal(modalityOf("vision"), "vision", "vision → vision");
  assert.equal(modalityOf("gte-large"), "embed", "gte-large → embed");
  assert.equal(modalityOf("stt"), "stt", "stt → stt");
  assert.equal(modalityOf("tts"), "tts", "tts → tts");
  assert.equal(modalityOf("chat"), "chat", "chat → chat");
  assert.equal(modalityOf("health"), "chat", "health → chat");

  // 2. filterReceipts — each facet, and AND-composition.
  const data = [
    r({ direction: "spend", status: "settled", counterparty: "Pro", alias: "gte-large", at: "2026-06-11T09:00:00Z" }),
    r({ direction: "earn", status: "settled", counterparty: "mac3", alias: "chat", at: "2026-06-11T11:00:00Z" }),
    r({ direction: "spend", status: "retrying", counterparty: "Pro", alias: "vision", at: "2026-06-10T08:00:00Z" }),
  ];
  assert.equal(filterReceipts(data, { ...EMPTY_FILTERS, flow: "spend" }).length, 2, "flow=spend → 2");
  assert.equal(filterReceipts(data, { ...EMPTY_FILTERS, status: "retrying" }).length, 1, "status=retrying → 1");
  assert.equal(filterReceipts(data, { ...EMPTY_FILTERS, peer: "mac3" }).length, 1, "peer=mac3 → 1");
  assert.equal(filterReceipts(data, { ...EMPTY_FILTERS, modality: "vision" }).length, 1, "modality=vision → 1");
  assert.equal(filterReceipts(data, { flow: "spend", status: "settled", peer: "Pro", modality: "embed" }).length, 1, "all four facets AND → 1");
  assert.equal(filterReceipts(data, EMPTY_FILTERS).length, 3, "no filter → all");

  // 3. groupByDay — newest day first, per-day signed net.
  const groups = groupByDay(data);
  assert.deepEqual(groups.map((g) => g.day), ["2026-06-11", "2026-06-10"], "days newest-first");
  // 06-11: +10 (earn) −10 (spend) = 0 ; 06-10: −10 (spend retrying) = −10
  assert.equal(groups[0]!.net, 0, "06-11 net = 0");
  assert.equal(groups[1]!.net, -10, "06-10 net = -10");
  assert.equal(groups[0]!.receipts.length, 2, "06-11 has 2 rows");

  // 4. paginateDays — pages of ~pageSize rows, a day never split.
  const many = groupByDay([
    ...Array.from({ length: 3 }, (_, i) => r({ at: "2026-06-11T0" + i + ":00:00Z" })), // day A: 3
    ...Array.from({ length: 3 }, (_, i) => r({ at: "2026-06-10T0" + i + ":00:00Z" })), // day B: 3
    ...Array.from({ length: 2 }, (_, i) => r({ at: "2026-06-09T0" + i + ":00:00Z" })), // day C: 2
  ]);
  const pages = paginateDays(many, 4); // A(3) fits; +B(3)=6>4 → new page; B(3)+C(2)=5>4 → new page
  assert.equal(pages.length, 3, "3 pages (no day split at size 4)");
  assert.deepEqual(pages.map((p) => p.reduce((s, g) => s + g.receipts.length, 0)), [3, 3, 2], "page row counts");

  // 5. facet sources present in the data.
  assert.deepEqual(peersIn(data).sort(), ["Pro", "mac3"], "peers present");
  assert.deepEqual(modalitiesIn(data), ["chat", "vision", "embed"], "modalities present, in canonical order");

  console.log("✅ receipt-view — modality / 4 filter facets / day-grouping+net / day-aware pagination / facet sources — GO");
}

main();
