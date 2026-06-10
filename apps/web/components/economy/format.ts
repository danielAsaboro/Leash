/** Shared formatting for the Economy Ledger (µ = micro-units of the stablecoin, e.g. µUSDT0). */
export const fmtMu = (n: number): string => `${Math.round(n).toLocaleString("en-US")}µ`;
export const fmtSignedMu = (n: number): string => `${n >= 0 ? "+" : "−"}${Math.abs(Math.round(n)).toLocaleString("en-US")}µ`;
export const fmtScore = (n: number): string => n.toFixed(3);
export const shortAddr = (a: string | null | undefined): string => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
