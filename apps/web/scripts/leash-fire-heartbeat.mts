/**
 * leash-fire-heartbeat — the shell-task entry the SCHEDULER (mcp-cron) runs on the
 * heartbeat cadence. It reuses the EXISTING server-to-server surface unchanged: POST
 * `/api/leash/heartbeat` with the shared internal token. No new auth, no new route.
 *
 *   npx tsx apps/web/scripts/leash-fire-heartbeat.mts [maxPerDay|-] [activeStart HH:MM|-] [activeEnd HH:MM|-]
 *
 * Env it relies on (all inherited from the mcp-cron daemon, which inherits the web
 * process's scope env — proven in spike/09-mcp-cron.ts):
 *   · LEASH_INTERNAL_TOKEN   — the shared token (preferred); else read from the token file
 *   · LEASH_WEB_PORT / PORT  — where the web app listens (default 6801)
 *   · LEASH_DATA_DIR         — for the token-file fallback (<data>/.leash-internal-token)
 *
 * The ACTIVE-HOURS gate lives here (ported verbatim from leash-cron's withinActiveHours):
 * mcp-cron fires the bare cron cadence, and this script no-ops (exit 0, "skipped") outside
 * the window — exactly as leash-cron did when it ticked. The per-day budget (maxPerDay)
 * is enforced INSIDE the heartbeat route. Exit 0 on a 2xx (incl. a silent/suppressed turn
 * or an active-hours skip), 1 on failure, so the run history records ok/error.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // apps/web/scripts
const REPO_ROOT = join(here, "..", "..", ".."); // → monorepo root
const DATA_DIR = process.env["LEASH_DATA_DIR"] ?? join(REPO_ROOT, "data");
const TOKEN_FILE = process.env["LEASH_INTERNAL_TOKEN_FILE"] ?? join(DATA_DIR, ".leash-internal-token");
const WEB_BASE = process.env["LEASH_WEB_BASE"] ?? `http://127.0.0.1:${process.env["LEASH_WEB_PORT"] ?? process.env["PORT"] ?? "6801"}`;

/** Token: env first (inherited from the scope), file fallback (matches leash-cron's contract). */
function internalToken(): string {
  const fromEnv = process.env["LEASH_INTERNAL_TOKEN"]?.trim();
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

const arg = (i: number): string | undefined => {
  const v = process.argv[i];
  return v && v !== "-" ? v : undefined;
};
const maxPerDay = Number(arg(2) ?? "") || undefined;
const activeStart = arg(3);
const activeEnd = arg(4);

/** Local active-hours gate (ported from leash-cron): inclusive start, exclusive end, wraps midnight. */
function withinActiveHours(start: string | undefined, end: string | undefined, now: number): boolean {
  if (!start || !end) return true;
  const mins = (s: string): number => {
    const [h, m] = s.split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  const d = new Date(now);
  const cur = d.getHours() * 60 + d.getMinutes();
  const s = mins(start);
  const e = mins(end);
  return s <= e ? cur >= s && cur < e : cur >= s || cur < e;
}

if (!withinActiveHours(activeStart, activeEnd, Date.now())) {
  process.stdout.write(`outside active hours (${activeStart}–${activeEnd}) — skipped\n`);
  process.exit(0);
}

const tok = internalToken();
if (!tok) {
  process.stderr.write(`no internal token (env LEASH_INTERNAL_TOKEN or ${TOKEN_FILE}) — is the web app running/seeded?\n`);
  process.exit(1);
}

try {
  const res = await fetch(`${WEB_BASE}/api/leash/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-leash-internal": tok },
    body: JSON.stringify({ maxPerDay }),
  });
  const text = await res.text();
  if (!res.ok) {
    process.stderr.write(`web returned ${res.status}: ${text.slice(0, 500)}\n`);
    process.exit(1);
  }
  // Relay the verdict to stdout so it lands in mcp-cron's result row (the run history).
  let out = text;
  try {
    const body = JSON.parse(text) as { suppressed?: boolean; proposal?: string | null; error?: string };
    if (body.error) {
      process.stderr.write(`${body.error}\n`);
      process.exit(1);
    }
    out = body.suppressed ? "HEARTBEAT_OK (silent)" : (body.proposal ?? "").slice(0, 1500) || "(no proposal)";
  } catch {
    /* not JSON — relay raw */
  }
  process.stdout.write(out + "\n");
  process.exit(0);
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
