"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { fetchWithTimeout } from "../lib/http.ts";
import type { SecretStatus } from "../lib/leash/vault.ts";

/**
 * Connections & Secrets (client) — set the credentials Leash's connectors use (Home
 * Assistant URL/token, SearXNG URL). Values are AES-encrypted at rest in the vault and
 * NEVER returned to the browser; the UI only knows whether each is set and from where.
 * Editing takes effect on the next tool call / search — no restart.
 */
export function SecretsCard({ secrets }: { secrets: SecretStatus[] }) {
  const router = useRouter();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const save = async (name: string) => {
    setBusy(name);
    setError(null);
    try {
      const res = await fetchWithTimeout("/api/leash/secrets", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, value: drafts[name] ?? "" }) });
      if (!res.ok) setError(`Save failed (${res.status}).`);
      else {
        setEditing(null);
        setDrafts((d) => ({ ...d, [name]: "" }));
      }
      router.refresh();
    } catch {
      setError("Save failed — is the app still running?");
    } finally {
      setBusy(null);
    }
  };

  const clear = async (name: string) => {
    if (!confirm("Clear this secret from the vault?")) return;
    setBusy(name);
    setError(null);
    try {
      const res = await fetchWithTimeout(`/api/leash/secrets?name=${encodeURIComponent(name)}`, { method: "DELETE" });
      if (!res.ok) setError(`Clear failed (${res.status}).`);
      router.refresh();
    } catch {
      setError("Clear failed — is the app still running?");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="border p-5" style={{ borderColor: "var(--color-rule)", background: "var(--color-paper)" }}>
      <div className="mb-1 flex items-center gap-3">
        <span className="kicker kicker-sage">Connections &amp; Secrets</span>
        <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
      </div>
      <p className="mb-3" style={{ color: "var(--color-muted)", fontSize: "0.85rem", fontFamily: "var(--font-body)" }}>
        Encrypted at rest (AES-256-GCM); values never leave the server. Edits apply on the next use — no restart.
      </p>
      {error && (
        <p className="kicker mb-2" style={{ color: "var(--color-brick)" }} role="alert">
          {error}
        </p>
      )}

      <ul>
        {secrets.map((s) => (
          <li key={s.name} className="flex flex-wrap items-center gap-3 border-b py-3" style={{ borderColor: "var(--color-rule)" }}>
            <div className="min-w-0 flex-1">
              <p style={{ fontFamily: "var(--font-body)", fontSize: "0.95rem" }}>
                {s.label}{" "}
                <span className="kicker ml-1" style={{ color: s.inVault ? "var(--color-sage-deep)" : s.fromEnv ? "#b8860b" : "var(--color-faint)" }}>
                  {s.inVault ? "● set (vault)" : s.fromEnv ? "● from env" : "○ not set"}
                </span>
              </p>
              <p className="kicker" style={{ color: "var(--color-faint)" }}>
                {s.hint}
              </p>
            </div>
            {editing === s.name ? (
              <>
                <input
                  type="password"
                  autoFocus
                  value={drafts[s.name] ?? ""}
                  onChange={(e) => setDrafts((d) => ({ ...d, [s.name]: e.target.value }))}
                  placeholder="New value…"
                  aria-label={`${s.label} value`}
                  className="min-w-[200px] flex-1 border bg-transparent px-3 py-2"
                  style={{ borderColor: "var(--color-rule-strong)", fontFamily: "var(--font-mono)", fontSize: "0.8rem" }}
                />
                <button type="button" disabled={busy === s.name} onClick={() => void save(s.name)} className="kicker px-3 py-1.5 transition-opacity hover:opacity-80" style={{ background: "var(--color-sage-deep)", color: "var(--color-cream)" }}>
                  Save
                </button>
                <button type="button" onClick={() => setEditing(null)} className="kicker border px-3 py-1.5 transition-opacity hover:opacity-70" style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button type="button" disabled={busy === s.name} onClick={() => setEditing(s.name)} className="kicker border px-3 py-1.5 transition-opacity hover:opacity-70" style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }}>
                  {s.inVault ? "Replace" : "Set"}
                </button>
                {s.inVault && (
                  <button type="button" disabled={busy === s.name} onClick={() => void clear(s.name)} className="kicker border px-3 py-1.5 transition-opacity hover:opacity-70" style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-brick)" }}>
                    Clear
                  </button>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
