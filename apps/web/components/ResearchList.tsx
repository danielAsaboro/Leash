"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchWithTimeout } from "../lib/http.ts";
import type { ResearchStatus } from "../lib/leash/research-store.ts";

/**
 * Deep-research list — the start-a-run form + a paginated, read-only list of runs. Each row
 * links to /research/<id> (where the synapse + report + cancel/delete live). Polls (router.refresh)
 * while any run on the page is active. Online feature — needs network for the web search.
 */

const STATE_LABEL: Record<ResearchStatus["state"], string> = {
  planning: "Planning",
  searching: "Searching",
  reading: "Reading sources",
  synthesizing: "Synthesizing",
  done: "Done",
  error: "Error",
};
const STATE_COLOR: Record<ResearchStatus["state"], string> = {
  planning: "var(--color-faint)",
  searching: "var(--color-sage-deep)",
  reading: "var(--color-sage-deep)",
  synthesizing: "var(--color-sage-deep)",
  done: "var(--color-sage)",
  error: "var(--color-brick)",
};
function rel(ms: number): string {
  const m = Math.floor((Date.now() - ms) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}

export function ResearchList({ runs, page, pages, total, perPage }: { runs: ResearchStatus[]; page: number; pages: number; total: number; perPage: number }) {
  const router = useRouter();
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = runs.some((r) => r.state !== "done" && r.state !== "error");
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(t);
  }, [active, router]);

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!question.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetchWithTimeout("/api/leash/research", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question }) });
      if (!res.ok) setError(`Couldn't start research (${res.status}).`);
      else setQuestion("");
      router.refresh();
    } catch {
      setError("Request failed — is the app still running?");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={start} className="flex flex-wrap gap-2 border p-4" style={{ borderColor: "var(--color-rule)", background: "var(--color-paper)" }}>
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask a research question… (e.g. 'Compare on-device LLM runtimes for Apple Silicon in 2026')"
          aria-label="Research question"
          className="min-w-[280px] flex-1 border bg-transparent px-3 py-2"
          style={{ borderColor: "var(--color-rule-strong)", fontFamily: "var(--font-body)", fontSize: "0.95rem" }}
        />
        <button type="submit" disabled={busy || !question.trim()} className="kicker px-4 py-2.5 transition-opacity hover:opacity-80 disabled:opacity-40" style={{ background: "var(--color-sage-deep)", color: "var(--color-cream)" }}>
          Research
        </button>
      </form>
      {error && (
        <p className="kicker" style={{ color: "var(--color-brick)" }} role="alert">
          {error}
        </p>
      )}
      <p className="kicker" style={{ color: "var(--color-faint)" }}>
        Online feature — gathers and reads live web sources (keyless DuckDuckGo, or SearXNG if configured), then synthesizes on-device. A run takes a few minutes.
      </p>

      {runs.length === 0 ? (
        <p className="kicker py-4" style={{ color: "var(--color-faint)" }}>
          No research runs yet.
        </p>
      ) : (
        <ul>
          {runs.map((r) => {
            const activeRun = r.state !== "done" && r.state !== "error";
            return (
              <li key={r.id} className="border-b py-2.5" style={{ borderColor: "var(--color-rule)" }}>
                <a href={`/research/${r.id}`} className="block transition-opacity hover:opacity-70">
                  <p className="truncate" style={{ fontFamily: "var(--font-body)", fontSize: "0.92rem" }}>
                    {r.question}
                  </p>
                  <p className="kicker mt-0.5 flex items-center gap-2">
                    <span style={{ color: STATE_COLOR[r.state] }}>
                      {STATE_LABEL[r.state]}
                      {activeRun ? ` · round ${r.round}/${r.maxRounds}` : ""}
                    </span>
                    <span style={{ color: "var(--color-faint)" }} suppressHydrationWarning>
                      {r.sources.length} sources · {rel(r.startedAt)}
                    </span>
                  </p>
                </a>
              </li>
            );
          })}
        </ul>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-between">
          <a href={`/research?offset=${Math.max(0, (page - 2) * perPage)}`} className="kicker" style={{ visibility: page > 1 ? "visible" : "hidden", color: "var(--color-sage-deep)" }}>‹ Newer</a>
          <span className="kicker" style={{ color: "var(--color-faint)" }}>page {page}/{pages} · {total} runs</span>
          <a href={`/research?offset=${page * perPage}`} className="kicker" style={{ visibility: page < pages ? "visible" : "hidden", color: "var(--color-sage-deep)" }}>Older ›</a>
        </div>
      )}
    </div>
  );
}
