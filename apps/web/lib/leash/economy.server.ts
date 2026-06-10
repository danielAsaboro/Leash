/**
 * Economy snapshot (server-only) for the `/economy` Ledger tab.
 *
 * Reads the daemon's `GET /receipts` + `GET /reputation` + `GET /peers` (the new `self` field) and
 * folds them with the pure {@link deriveEconomy}. Best-effort: a down daemon surfaces an honest
 * `error` string the page shows — never silent-catch to an empty UI (matches lib/leash/hypha.ts).
 */
import "server-only";
import { deriveEconomy, type EconomyPeer, type EconomyReceipt, type EconomyReputation, type EconomySelf, type EconomySnapshot } from "./economy.ts";

const HYPHA_PORT = Number(process.env["HYPHA_PORT"] ?? 11437);
const BASE = `http://127.0.0.1:${HYPHA_PORT}`;

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(1500), cache: "no-store" });
  if (!r.ok) throw new Error(`Hypha shim answered ${r.status} on ${path}`);
  return (await r.json()) as T;
}

export interface EconomyResult {
  snapshot: EconomySnapshot;
  /** Null when the daemon answered; a message when it didn't (shown on the page). */
  error: string | null;
}

const EMPTY: EconomySnapshot = {
  wallet: null, asset: "USDT0", networkId: null, earned: 0, spent: 0, net: 0,
  settledCount: 0, earnedSeries: [], spentSeries: [], market: [], receipts: [],
};

export async function economySnapshot(): Promise<EconomyResult> {
  try {
    const [receiptsBody, reputationBody, peersBody] = await Promise.all([
      get<{ receipts?: EconomyReceipt[] }>("/receipts"),
      get<{ reputation?: EconomyReputation[] }>("/reputation"),
      get<{ peers?: EconomyPeer[]; self?: EconomySelf }>("/peers"),
    ]);
    const self: EconomySelf = peersBody.self ?? { providerKey: null, wallet: null };
    const snapshot = deriveEconomy(receiptsBody.receipts ?? [], reputationBody.reputation ?? [], peersBody.peers ?? [], self);
    return { snapshot, error: null };
  } catch {
    return { snapshot: EMPTY, error: "Hypha daemon not running — start it on the Services page to see the live mesh economy." };
  }
}
