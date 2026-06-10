import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionSettlementReceipt } from "@mycelium/shared";
import type { ActiveSessionRecord, BlockedPayerRecord, UnsettledReceiptRecord, UsedAuthorizationRecord } from "./economy-types.ts";

interface StoredMaps {
  activeSessions: Map<string, ActiveSessionRecord>;
  usedAuthorizations: Map<string, UsedAuthorizationRecord>;
  unsettledReceipts: Map<string, UnsettledReceiptRecord>;
  blockedPayers: Map<string, BlockedPayerRecord>;
  settledReceipts: Map<string, SessionSettlementReceipt>;
}

const ACTIVE_SESSIONS_FILE = "active-sessions.json";
const USED_AUTHORIZATIONS_FILE = "used-authorizations.json";
const UNSETTLED_RECEIPTS_FILE = "unsettled-receipts.json";
const BLOCKED_PAYERS_FILE = "blocked-payers.json";
const SETTLED_RECEIPTS_FILE = "settled-receipts.json";

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function mapFromObject<T>(value: Record<string, T>): Map<string, T> {
  return new Map(Object.entries(value));
}

function mapToObject<T>(value: Map<string, T>): Record<string, T> {
  return Object.fromEntries(value);
}

export class ProviderEconomyStore {
  private readonly activeSessions: Map<string, ActiveSessionRecord>;
  private readonly usedAuthorizations: Map<string, UsedAuthorizationRecord>;
  private readonly unsettledReceipts: Map<string, UnsettledReceiptRecord>;
  private readonly blockedPayers: Map<string, BlockedPayerRecord>;
  private readonly settledReceipts: Map<string, SessionSettlementReceipt>;

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    const loaded: StoredMaps = {
      activeSessions: mapFromObject(readJson<Record<string, ActiveSessionRecord>>(join(dir, ACTIVE_SESSIONS_FILE), {})),
      usedAuthorizations: mapFromObject(readJson<Record<string, UsedAuthorizationRecord>>(join(dir, USED_AUTHORIZATIONS_FILE), {})),
      unsettledReceipts: mapFromObject(readJson<Record<string, UnsettledReceiptRecord>>(join(dir, UNSETTLED_RECEIPTS_FILE), {})),
      blockedPayers: mapFromObject(readJson<Record<string, BlockedPayerRecord>>(join(dir, BLOCKED_PAYERS_FILE), {})),
      settledReceipts: mapFromObject(readJson<Record<string, SessionSettlementReceipt>>(join(dir, SETTLED_RECEIPTS_FILE), {})),
    };
    this.activeSessions = loaded.activeSessions;
    this.usedAuthorizations = loaded.usedAuthorizations;
    this.unsettledReceipts = loaded.unsettledReceipts;
    this.blockedPayers = loaded.blockedPayers;
    this.settledReceipts = loaded.settledReceipts;
  }

  private save(name: string, data: unknown): void {
    writeFileSync(join(this.dir, name), JSON.stringify(data, null, 2) + "\n");
  }

  private flushActive(): void {
    this.save(ACTIVE_SESSIONS_FILE, mapToObject(this.activeSessions));
  }

  private flushUsed(): void {
    this.save(USED_AUTHORIZATIONS_FILE, mapToObject(this.usedAuthorizations));
  }

  private flushUnsettled(): void {
    this.save(UNSETTLED_RECEIPTS_FILE, mapToObject(this.unsettledReceipts));
  }

  private flushBlocked(): void {
    this.save(BLOCKED_PAYERS_FILE, mapToObject(this.blockedPayers));
  }

  private flushSettled(): void {
    this.save(SETTLED_RECEIPTS_FILE, mapToObject(this.settledReceipts));
  }

  getActiveSession(sessionId: string): ActiveSessionRecord | undefined {
    return this.activeSessions.get(sessionId);
  }

  activeSessionCount(): number {
    return this.activeSessions.size;
  }

  putActiveSession(record: ActiveSessionRecord): void {
    this.activeSessions.set(record.grant.sessionId, record);
    this.flushActive();
  }

  removeActiveSession(sessionId: string): void {
    if (!this.activeSessions.delete(sessionId)) return;
    this.flushActive();
  }

  authorizationUsed(authorizationDigest: string): boolean {
    return this.usedAuthorizations.has(authorizationDigest);
  }

  markAuthorizationUsed(authorizationDigest: string, sessionId: string): void {
    this.usedAuthorizations.set(authorizationDigest, {
      authorizationDigest,
      sessionId,
      usedAt: new Date().toISOString(),
    });
    this.flushUsed();
  }

  putUnsettled(record: UnsettledReceiptRecord): void {
    this.unsettledReceipts.set(record.receipt.sessionId, record);
    this.flushUnsettled();
  }

  listUnsettled(): UnsettledReceiptRecord[] {
    return [...this.unsettledReceipts.values()];
  }

  removeUnsettled(sessionId: string): void {
    if (!this.unsettledReceipts.delete(sessionId)) return;
    this.flushUnsettled();
  }

  putSettled(receipt: SessionSettlementReceipt): void {
    this.settledReceipts.set(receipt.sessionId, receipt);
    this.flushSettled();
  }

  getSettled(sessionId: string): SessionSettlementReceipt | undefined {
    return this.settledReceipts.get(sessionId);
  }

  listSettled(): SessionSettlementReceipt[] {
    return [...this.settledReceipts.values()];
  }

  getBlockedPayer(payerAddress: string): BlockedPayerRecord | undefined {
    return this.blockedPayers.get(payerAddress);
  }

  putBlockedPayer(record: BlockedPayerRecord): void {
    this.blockedPayers.set(record.payerAddress, record);
    this.flushBlocked();
  }

  clearBlockedPayer(payerAddress: string): void {
    if (!this.blockedPayers.delete(payerAddress)) return;
    this.flushBlocked();
  }

  listBlockedPayers(): BlockedPayerRecord[] {
    return [...this.blockedPayers.values()];
  }
}
