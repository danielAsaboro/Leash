"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { fetchWithTimeout } from "../lib/http.ts";
import type { LeashMemory, MemoryType } from "../lib/leash/memories-store.ts";

/**
 * Typed memories (client) — the atomic things the assistant knows about the user:
 * preference / fact / goal / person / routine. Preferences are injected into every
 * turn's system prompt; the rest are recall/RAG. Add, retype, edit, forget.
 */

const TYPES: MemoryType[] = ["preference", "fact", "goal", "person", "routine"];

function ago(ms: number): string {
  const d = Math.floor((Date.now() - ms) / 86400000);
  return d < 1 ? "today" : d === 1 ? "yesterday" : `${d}d ago`;
}

export function MemoriesSection({ memories }: { memories: LeashMemory[] }) {
  const router = useRouter();
  const [typeFilter, setTypeFilter] = useState<MemoryType | null>(null);
  const [newType, setNewType] = useState<MemoryType>("preference");
  const [newText, setNewText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const call = async (fn: () => Promise<Response>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) setError(`Request failed (${res.status}).`);
      router.refresh();
      return res.ok;
    } catch {
      setError("Request failed — is the app still running?");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newText.trim()) return;
    const ok = await call(() =>
      fetchWithTimeout("/api/leash/memory/items", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: newType, text: newText }) }),
    );
    if (ok) setNewText("");
  };

  const retype = (m: LeashMemory, type: string) =>
    void call(() => fetchWithTimeout(`/api/leash/memory/items/${m.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ type }) }));

  const edit = (m: LeashMemory) => {
    const text = prompt("Edit memory", m.text);
    if (text == null || !text.trim()) return;
    void call(() => fetchWithTimeout(`/api/leash/memory/items/${m.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) }));
  };

  const forget = (m: LeashMemory) => {
    if (!confirm("Forget this memory? The assistant will no longer know it.")) return;
    void call(() => fetchWithTimeout(`/api/leash/memory/items/${m.id}`, { method: "DELETE" }));
  };

  const shown = typeFilter ? memories.filter((m) => m.type === typeFilter) : memories;

  return (
    <section>
      <div className="mb-2 flex items-center gap-3">
        <span className="kicker kicker-sage">Memories</span>
        <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
        <span className="kicker" style={{ color: "var(--color-faint)" }}>
          preferences shape every turn · the rest are recalled on demand
        </span>
      </div>
      {error && (
        <p className="kicker mb-2" style={{ color: "var(--color-brick)" }} role="alert">
          {error}
        </p>
      )}

      {/* Type filter */}
      <div className="mb-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => setTypeFilter(null)} className="kicker border px-2.5 py-1 transition-opacity hover:opacity-70" style={!typeFilter ? { background: "var(--color-sage-deep)", color: "var(--color-cream)", borderColor: "var(--color-sage-deep)" } : { borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }}>
          All ({memories.length})
        </button>
        {TYPES.map((t) => (
          <button key={t} type="button" onClick={() => setTypeFilter(t)} className="kicker border px-2.5 py-1 transition-opacity hover:opacity-70" style={typeFilter === t ? { background: "var(--color-sage-deep)", color: "var(--color-cream)", borderColor: "var(--color-sage-deep)" } : { borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }}>
            {t} ({memories.filter((m) => m.type === t).length})
          </button>
        ))}
      </div>

      {/* Add */}
      <form onSubmit={add} className="mb-3 flex flex-wrap gap-2">
        <select value={newType} onChange={(e) => setNewType(e.target.value as MemoryType)} aria-label="Memory type" className="kicker border bg-transparent px-2 py-2" style={{ borderColor: "var(--color-rule-strong)" }}>
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <input
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
          placeholder="One self-contained sentence (e.g. 'Prefers metric units')…"
          aria-label="New memory text"
          className="min-w-[260px] flex-1 border bg-transparent px-3 py-2"
          style={{ borderColor: "var(--color-rule)", fontFamily: "var(--font-body)", fontSize: "0.9rem" }}
        />
        <button type="submit" disabled={busy || !newText.trim()} className="kicker px-3 py-2 transition-opacity hover:opacity-80 disabled:opacity-40" style={{ background: "var(--color-sage-deep)", color: "var(--color-cream)" }}>
          Remember
        </button>
      </form>

      {/* List */}
      {shown.length === 0 ? (
        <p className="kicker py-4" style={{ color: "var(--color-faint)" }}>
          No memories{typeFilter ? ` of type ${typeFilter}` : ""} yet — add one above, or tell the assistant something worth remembering.
        </p>
      ) : (
        <ul>
          {shown.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-3 border-b py-2.5" style={{ borderColor: "var(--color-rule)" }}>
              <select value={m.type} onChange={(e) => retype(m, e.target.value)} disabled={busy} aria-label="Type" className="kicker border bg-transparent px-2 py-1" style={{ borderColor: "var(--color-rule-strong)", color: m.type === "preference" ? "var(--color-sage-deep)" : "var(--color-muted)" }}>
                {TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <p className="min-w-0 flex-1" style={{ fontFamily: "var(--font-body)", fontSize: "0.95rem" }}>
                {m.text}
              </p>
              <span className="kicker" style={{ color: "var(--color-faint)" }} suppressHydrationWarning>
                {m.source} · {ago(m.updatedAt)}
              </span>
              <button type="button" onClick={() => edit(m)} disabled={busy} className="kicker border px-2 py-1 transition-opacity hover:opacity-70" style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-muted)" }}>
                Edit
              </button>
              <button type="button" onClick={() => forget(m)} disabled={busy} className="kicker border px-2 py-1 transition-opacity hover:opacity-70" style={{ borderColor: "var(--color-rule-strong)", color: "var(--color-brick)" }}>
                Forget
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
