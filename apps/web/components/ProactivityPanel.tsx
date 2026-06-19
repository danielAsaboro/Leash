"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { SaveIcon, Loader2Icon } from "lucide-react";
import { fetchWithTimeout } from "../lib/http.ts";
import { IconButton } from "./IconButton.tsx";
import { toast } from "./Toast.tsx";
import type { Constitution, ConstitutionField } from "../lib/leash/constitution.ts";

/**
 * Proactivity editor (client) — the three "constitution" markdown files that steer the proactive
 * assistant. soul.md + goals.md fold into every chat turn; heartbeat.md is the autonomous loop's
 * checklist. Saving writes the file via /api/leash/constitution; the next turn/heartbeat picks it up.
 */
const FIELDS: { key: ConstitutionField; label: string; blurb: string; rows: number }[] = [
  { key: "soul", label: "Soul", blurb: "Who you are — context + voice the assistant assumes on every turn.", rows: 8 },
  { key: "goals", label: "Goals", blurb: "Where you're going (≤5). Everything the assistant notices is judged against these.", rows: 7 },
  { key: "heartbeat", label: "Heartbeat", blurb: "What to watch each cycle — one `## check` per thing the assistant should look for.", rows: 12 },
];

export function ProactivityPanel({ constitution }: { constitution: Constitution }) {
  const router = useRouter();
  const [saved, setSaved] = useState<Constitution>(constitution);
  const [drafts, setDrafts] = useState<Constitution>(constitution);
  const [busy, setBusy] = useState<ConstitutionField | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async (field: ConstitutionField): Promise<void> => {
    setBusy(field);
    setError(null);
    try {
      const res = await fetchWithTimeout("/api/leash/constitution", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ field, content: drafts[field] }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        const msg = body.error ?? `Save failed (${res.status}).`;
        setError(msg);
        toast.error(msg);
        return;
      }
      const body = (await res.json()) as { constitution: Constitution };
      setSaved(body.constitution);
      setDrafts(body.constitution);
      toast.success(`${FIELDS.find((f) => f.key === field)?.label ?? "Constitution"} saved`);
      router.refresh();
    } catch {
      const msg = "Save failed — is the app still running?";
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {error && (
        <p className="kicker" style={{ color: "var(--color-brick)" }} role="alert">
          {error}
        </p>
      )}
      <p className="kicker" style={{ color: "var(--color-faint)" }}>
        These three files are the assistant&apos;s constitution — soul &amp; goals steer every chat turn; heartbeat drives the proactive loop.
      </p>

      {FIELDS.map(({ key, label, blurb, rows }) => {
        const dirty = drafts[key] !== saved[key];
        return (
          <section key={key} className="border p-4" style={{ borderColor: "var(--color-rule)", background: "var(--color-paper)" }}>
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <span className="kicker kicker-sage">{label}</span>
                <span className="ml-2" style={{ fontSize: "0.78rem", color: "var(--color-muted)" }}>
                  {blurb}
                </span>
              </div>
              <IconButton title={`Save ${label.toLowerCase()}`} color="var(--color-sage-deep)" disabled={busy !== null || !dirty} onClick={() => void save(key)}>
                {busy === key ? <Loader2Icon size={15} className="animate-spin" /> : <SaveIcon size={15} />}
              </IconButton>
            </div>
            <textarea
              value={drafts[key]}
              onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
              rows={rows}
              spellCheck={false}
              className="w-full border bg-transparent p-3"
              style={{ borderColor: "var(--color-rule-strong)", fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: "var(--color-ink)", resize: "vertical" }}
            />
          </section>
        );
      })}
    </div>
  );
}
