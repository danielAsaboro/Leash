/** Date helpers shared by the reader. Dates are YYYY-MM-DD edition keys. */

/** Today's local date as YYYY-MM-DD (matches the daemon's `today()`). */
export function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** "Tuesday, June 2, 2026" from a YYYY-MM-DD key (parsed as local noon, no TZ drift). */
export function formatLong(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12);
  return dt.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

/** Short "Jun 2" label. */
export function formatShort(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12);
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** "14:32" wall-clock from a Date. */
export function formatTime(d: Date): string {
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}
