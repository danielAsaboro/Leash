"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { DownloadIcon, ListPlusIcon, Loader2Icon } from "lucide-react";
import { fetchWithTimeout, TIMEOUT } from "../lib/http.ts";
import { IconButton } from "./IconButton.tsx";
import type { ForageResult, Recommendation } from "../lib/leash/forage.ts";

/**
 * Forage (client) — hardware-aware model recommendations. The organism's view of what
 * to run on THIS device: ranked per use-case, one-click Download or Add-to-config
 * (reusing the Models endpoints). Scores are estimates; labeled as such.
 */
export function ForagePanel({ result }: { result: ForageResult }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const download = (r: Recommendation) =>
    act(r.name, () => fetchWithTimeout("/api/leash/models/download", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: r.name }) }, TIMEOUT.heavy), `Downloading ${r.name}… track it on the Models tab.`);

  const addToConfig = (r: Recommendation) => {
    const alias = prompt(`Config alias for ${r.name}?`, r.name.toLowerCase().replace(/_/g, "-").slice(0, 24));
    if (!alias) return;
    void act(r.name, () => fetchWithTimeout("/api/leash/models/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "add", alias: alias.trim(), model: r.name }) }), `Added ${r.name} to config — restart the serve (Services) to load it.`);
  };

  async function act(name: string, fn: () => Promise<Response>, ok: string) {
    setBusy(name);
    setError(null);
    setNotice(null);
    try {
      const res = await fn();
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Request failed (${res.status}).`);
      } else setNotice(ok);
      router.refresh();
    } catch {
      setError("Request failed — is the app still running?");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="kicker" style={{ color: "var(--color-faint)" }}>
        Ranked for this machine ({result.deviceGB.toFixed(0)} GB unified memory) — only models that can actually run, best first. Speeds marked &ldquo;est.&rdquo; are bandwidth estimates; the rest are measured from real turns.
      </p>
      {error && (
        <p className="kicker" style={{ color: "var(--color-brick)" }} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="kicker" style={{ color: "var(--color-sage-deep)" }}>
          {notice}
        </p>
      )}

      {result.groups.length === 0 ? (
        <p className="kicker py-6 text-center" style={{ color: "var(--color-faint)" }}>
          No recommendations yet — the catalog hasn&rsquo;t been built. Open the Models tab once to generate it.
        </p>
      ) : (
        result.groups.map((g) => (
          <section key={g.useCase}>
            <div className="mb-2 flex items-center gap-3">
              <span className="kicker kicker-sage">{g.label}</span>
              <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
            </div>
            {g.useCase === "chat" && (
              <p className="kicker mb-2" style={{ color: "var(--color-faint)" }}>
                Heads up: reliable <em>tool use</em> (agents, deep research) generally needs ≥14B + coder/agent post-training — 4–8B Instruct models chat fine but call tools unreliably. For plain conversation any of these are great.
              </p>
            )}
            <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {g.recommendations.map((r, i) => (
                <li key={r.name} className="flex items-start gap-3 border p-3" style={{ borderColor: i === 0 && !r.inConfig ? "var(--color-sage)" : "var(--color-rule)", background: "var(--color-paper)" }}>
                  <span style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: "1.2rem", color: "var(--color-sage-deep)", minWidth: "2ch" }}>{r.score}</span>
                  <div className="min-w-0 flex-1">
                    <p style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>
                      {r.name}
                      {i === 0 && !r.inConfig && <span className="kicker ml-2" style={{ color: "var(--color-sage)" }}>top pick</span>}
                      {r.inConfig && <span className="kicker ml-2" style={{ color: "var(--color-faint)" }}>in config{r.alias ? ` as ${r.alias}` : ""}</span>}
                    </p>
                    <p className="kicker mt-0.5" style={{ color: "var(--color-faint)" }}>
                      ≈{r.gb}G · {r.why}
                    </p>
                    <div className="mt-1 flex gap-1">
                      {!r.downloaded && (
                        <IconButton title={`Download ${r.name}`} disabled={busy === r.name} onClick={() => void download(r)}>
                          {busy === r.name ? <Loader2Icon size={14} className="animate-spin" /> : <DownloadIcon size={14} />}
                        </IconButton>
                      )}
                      {!r.inConfig && (
                        <IconButton title={`Add ${r.name} to config`} color="var(--color-sage-deep)" disabled={busy === r.name} onClick={() => addToConfig(r)}>
                          <ListPlusIcon size={14} />
                        </IconButton>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
