"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { fetchWithTimeout } from "../lib/http.ts";

/**
 * Mission Control's first WRITE action (client) — the gated "Re-queue" button on a
 * stuck article. Honest labeling: a re-queue re-runs the FULL pipeline (no per-stage
 * resume). The server re-checks eligibility (mid-pipeline + stalled >5 min), so this
 * button being enabled is a hint, not the gate.
 */
export function MissionControlActions({ id, headline, eligible, reason }: { id: string; headline: string; eligible: boolean; reason: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requeue = async () => {
    if (!confirm(`Re-queue “${headline}”?\n\nThe pipeline re-runs from scratch (research → draft → review) — work done so far on this story is redone, not resumed.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetchWithTimeout(`/api/leash/newsroom/articles/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "requeue" }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Re-queue failed (${res.status}).`);
      }
      router.refresh();
    } catch {
      setError("Request failed — is the app still running?");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={busy || !eligible}
        onClick={() => void requeue()}
        title={eligible ? "Send back to QUEUED — the daemon re-runs the full pipeline" : reason}
        className="kicker border px-3 py-1.5 transition-opacity hover:opacity-70 disabled:opacity-40"
        style={{ borderColor: "var(--color-control-line)", color: eligible ? "var(--color-glow)" : "var(--color-faint)" }}
      >
        {busy ? "Re-queuing…" : "Re-queue"}
      </button>
      {!eligible && (
        <span className="kicker" style={{ color: "var(--color-faint)" }}>
          {reason}
        </span>
      )}
      {error && (
        <span className="kicker" style={{ color: "var(--color-brick)" }} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
