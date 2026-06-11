"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { SaveIcon, RotateCcwIcon, Loader2Icon } from "lucide-react";
import { fetchWithTimeout } from "../lib/http.ts";
import { IconButton } from "./IconButton.tsx";
import type { PromptView } from "../lib/leash/prompts-store.ts";

/**
 * Prompt editor (client) — one card per Leash prompt. Saving a non-default text sets
 * an override in data/leash-prompts.json; Reset clears it back to the code default.
 * The next chat turn picks the change up immediately (mtime-cached store read).
 */
export function PromptsPanel({ prompts }: { prompts: PromptView[] }) {
  const router = useRouter();
  const [drafts, setDrafts] = useState<Record<string, string>>(Object.fromEntries(prompts.map((p) => [p.key, p.value])));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const put = async (key: string, value: string | null) => {
    setBusy(key);
    setError(null);
    try {
      const res = await fetchWithTimeout("/api/leash/prompts", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, value }) });
      if (!res.ok) setError(`Save failed (${res.status}).`);
      router.refresh();
    } catch {
      setError("Save failed — is the app still running?");
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
      {prompts.map((p) => {
        const draft = drafts[p.key] ?? p.value;
        const dirty = draft !== p.value;
        return (
          <section key={p.key} className="border p-4" style={{ borderColor: "var(--color-rule)", background: "var(--color-paper)" }}>
            <div className="mb-1 flex items-baseline justify-between gap-3">
              <span className="kicker kicker-sage">{p.label}</span>
              <span className="kicker" style={{ color: p.overridden ? "var(--color-sage-deep)" : "var(--color-faint)" }}>
                {p.overridden ? "Overridden" : "Default"}
              </span>
            </div>
            <p className="mb-2" style={{ color: "var(--color-muted)", fontSize: "0.85rem", fontFamily: "var(--font-body)" }}>
              {p.hint}
            </p>
            <textarea
              value={draft}
              onChange={(e) => setDrafts((d) => ({ ...d, [p.key]: e.target.value }))}
              rows={Math.min(12, Math.max(4, Math.ceil(draft.length / 90)))}
              className="w-full border bg-transparent p-3"
              style={{ borderColor: "var(--color-rule-strong)", fontFamily: "var(--font-mono)", fontSize: "0.78rem", lineHeight: 1.5 }}
              aria-label={`${p.label} text`}
            />
            <div className="mt-2 flex items-center gap-2">
              <IconButton title="Save override" color="var(--color-sage-deep)" disabled={busy === p.key || !dirty || !draft.trim()} onClick={() => void put(p.key, draft)}>
                {busy === p.key ? <Loader2Icon size={15} className="animate-spin" /> : <SaveIcon size={15} />}
              </IconButton>
              <IconButton
                title="Reset to default"
                disabled={busy === p.key || !p.overridden}
                onClick={() => {
                  setDrafts((d) => ({ ...d, [p.key]: p.defaultValue }));
                  void put(p.key, null);
                }}
              >
                <RotateCcwIcon size={15} />
              </IconButton>
              {dirty && (
                <span className="kicker" style={{ color: "var(--color-faint)" }}>
                  Unsaved changes
                </span>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
