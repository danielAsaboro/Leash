"use client";
import { useCallback, useEffect, useState } from "react";
import { fetchWithTimeout, TIMEOUT } from "../lib/http.ts";

/**
 * Mesh model sharing — the per-node "share my models" toggle + a view of what peers share, with a
 * Pull that reuses the proven P2P download (a peer's alias resolves to a registry name via this
 * node's mesh-synced config). Errors are surfaced, never silent-caught.
 */
interface SharePeer { displayName: string; live: boolean; shareModels: boolean; models: string[] }
interface ShareState { shareModels: boolean; peers: SharePeer[]; aliasToName: Record<string, string>; myModels: string[] }
interface DlStatus { name: string; state: string; percentage: number }

export function MeshShareCard() {
  const [s, setS] = useState<ShareState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dls, setDls] = useState<Record<string, DlStatus>>({});

  const load = useCallback(async () => {
    try {
      const r = await fetchWithTimeout("/api/leash/hypha/share", { cache: "no-store" }, TIMEOUT.probe);
      const d = (await r.json()) as ShareState & { ok?: boolean; error?: string };
      if (!r.ok || d.ok === false) throw new Error(d.error ?? "couldn't load mesh sharing");
      setS({ shareModels: d.shareModels, peers: d.peers ?? [], aliasToName: d.aliasToName ?? {}, myModels: d.myModels ?? [] });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Poll download status while any pull is in flight.
  const pollDownloads = useCallback(async () => {
    try {
      const r = await fetchWithTimeout("/api/leash/models/download", { cache: "no-store" }, TIMEOUT.probe);
      const d = (await r.json()) as { downloads?: DlStatus[] };
      const map: Record<string, DlStatus> = {};
      for (const x of d.downloads ?? []) map[x.name] = x;
      setDls(map);
    } catch { /* status poll is best-effort */ }
  }, []);

  useEffect(() => {
    void load();
    const a = setInterval(() => void load(), 6000);
    const b = setInterval(() => void pollDownloads(), 2500);
    return () => { clearInterval(a); clearInterval(b); };
  }, [load, pollDownloads]);

  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      const r = await fetchWithTimeout("/api/leash/hypha/share", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on }) }, TIMEOUT.crud);
      if (!r.ok) throw new Error("toggle failed");
      setS((p) => (p ? { ...p, shareModels: on } : p));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const pull = async (alias: string) => {
    const name = s?.aliasToName[alias];
    if (!name) { setError(`can't resolve "${alias}" to a registry model to pull`); return; }
    try {
      await fetchWithTimeout("/api/leash/models/download", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }, TIMEOUT.heavy);
      void pollDownloads();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const have = new Set(s?.myModels ?? []);

  return (
    <section className="border p-5" style={{ borderColor: "var(--color-rule)", background: "var(--color-paper)" }}>
      <div className="mb-3 flex items-center gap-3">
        <span className="kicker kicker-sage">Mesh model sharing</span>
        <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
        {s && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void toggle(!s.shareModels)}
            className="inline-flex items-center gap-2"
            style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", letterSpacing: "0.08em", textTransform: "uppercase", color: s.shareModels ? "var(--color-sage-deep)" : "var(--color-faint)", background: "none", border: "1px solid var(--color-rule)", borderRadius: 999, padding: "3px 10px", cursor: "pointer" }}
          >
            <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: s.shareModels ? "var(--color-sage)" : "var(--color-faint)" }} />
            {s.shareModels ? "sharing" : "private"}
          </button>
        )}
      </div>

      <p className="italic" style={{ color: "var(--color-muted)", fontFamily: "var(--font-body)", fontSize: "0.9rem", marginBottom: "0.75rem" }}>
        When sharing, peers can discover and pull your cached models over P2P. Pull a model a peer has that you don’t.
      </p>

      {error && (
        <div className="mb-3 flex items-center gap-2 px-3 py-2" style={{ border: "1px solid var(--color-brick)", background: "color-mix(in srgb, var(--color-brick) 8%, var(--color-paper))" }}>
          <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: "var(--color-brick)" }} />
          <span style={{ fontFamily: "var(--font-body)", color: "var(--color-ink-soft)", fontSize: "0.85rem" }}>{error}</span>
        </div>
      )}

      {!s ? (
        <p className="kicker" style={{ color: "var(--color-faint)" }}>Loading…</p>
      ) : s.peers.length === 0 ? (
        <p className="italic" style={{ color: "var(--color-faint)", fontFamily: "var(--font-body)" }}>No peers yet — pair a device to share models across the mesh.</p>
      ) : (
        <div>
          {s.peers.map((p) => (
            <div key={p.displayName} className="grid items-start gap-3 border-b py-2.5" style={{ gridTemplateColumns: "minmax(0,1fr) 2.4fr", borderColor: "var(--color-rule)" }}>
              <span className="flex items-center gap-2 min-w-0">
                <span aria-hidden className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: p.live ? "var(--color-sage)" : "var(--color-faint)" }} />
                <span className="truncate" style={{ fontFamily: "var(--font-body)", color: "var(--color-ink)" }}>{p.displayName}</span>
                {!p.shareModels && <span className="kicker shrink-0" style={{ color: "var(--color-faint)" }}>private</span>}
              </span>
              <span className="flex flex-wrap gap-1.5">
                {p.models.length === 0 && <span className="kicker" style={{ color: "var(--color-faint)" }}>—</span>}
                {p.models.map((alias) => {
                  const mine = have.has(alias);
                  const dl = s.aliasToName[alias] ? dls[s.aliasToName[alias]] : undefined;
                  const pulling = dl && (dl.state === "downloading" || dl.state === "starting");
                  return (
                    <span key={alias} className="inline-flex items-center gap-1.5" style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem", border: "1px solid var(--color-rule)", borderRadius: 4, padding: "1px 6px", color: "var(--color-ink-soft)" }}>
                      {alias}
                      {mine ? (
                        <span title="cached locally" style={{ color: "var(--color-sage-deep)" }}>✓</span>
                      ) : pulling ? (
                        <span style={{ color: "var(--color-sage-deep)" }}>{Math.floor(dl!.percentage)}%</span>
                      ) : dl?.state === "done" ? (
                        <span style={{ color: "var(--color-sage-deep)" }}>✓</span>
                      ) : p.shareModels ? (
                        <button type="button" onClick={() => void pull(alias)} style={{ color: "var(--color-glow)", background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>↓ pull</button>
                      ) : null}
                    </span>
                  );
                })}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
