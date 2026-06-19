"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2Icon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { fetchWithTimeout } from "../lib/http.ts";
import { appConfirm } from "../lib/prompt.ts";
import { IconButton } from "./IconButton.tsx";
import type { ActivityPage } from "../lib/leash/memory-admin.ts";

/**
 * Screen activity the assistant recalls — the watcher's ~2-min observations. Forgetting a
 * record tombstones it (the JSONL is never rewritten). Paginated; the full view lives at
 * /brain/screen-activity, a preview on /brain.
 */

function fmtTime(ms: number | string): string {
  return new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

export function ScreenActivitySection({ activity, offset, pageSize = 50 }: { activity: ActivityPage; offset: number; pageSize?: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const forget = async (ts: string) => {
    if (!(await appConfirm("Forget this activity record? The assistant will no longer recall it.", { confirmLabel: "Forget", destructive: true }))) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetchWithTimeout("/api/leash/memory/forget", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "activity", ts }) });
      if (!res.ok) setError(`Forget failed (${res.status}).`);
      router.refresh();
    } catch {
      setError("Forget failed — is the app still running?");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {error && (
        <p className="kicker" style={{ color: "var(--color-brick)" }} role="alert">
          {error}
        </p>
      )}
      {activity.records.length === 0 ? (
        <p className="kicker py-4" style={{ color: "var(--color-faint)" }}>
          No activity recorded{activity.total > 0 ? " on this page" : " — start the watcher with `npm run watch`"}.
        </p>
      ) : (
        <ul>
          {activity.records.map((r) => (
            <li key={r.ts} className="flex items-start gap-3 border-b py-2.5" style={{ borderColor: "var(--color-rule)" }}>
              <div className="min-w-0 flex-1">
                <p style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>
                  {fmtTime(r.ts)} · {r.app}
                  {r.window ? ` — ${r.window}` : ""}
                </p>
                <p style={{ color: "var(--color-muted)", fontSize: "0.85rem", fontFamily: "var(--font-body)" }}>{r.summary}</p>
              </div>
              <IconButton title="Forget this record" danger disabled={busy} onClick={() => void forget(r.ts)}>
                <Trash2Icon size={15} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}

      {activity.total > activity.records.length && (
        <div className="mt-2 flex items-center gap-1">
          {offset > 0 && (
            <IconButton title="Newer" onClick={() => router.push(`/brain/screen-activity?offset=${Math.max(0, offset - pageSize)}`)}>
              <ChevronLeftIcon size={16} />
            </IconButton>
          )}
          <span className="kicker" style={{ color: "var(--color-faint)" }}>
            {offset + 1}–{offset + activity.records.length} of {activity.total}
          </span>
          {offset + activity.records.length < activity.total && (
            <IconButton title="Older" onClick={() => router.push(`/brain/screen-activity?offset=${offset + pageSize}`)}>
              <ChevronRightIcon size={16} />
            </IconButton>
          )}
        </div>
      )}
    </div>
  );
}
