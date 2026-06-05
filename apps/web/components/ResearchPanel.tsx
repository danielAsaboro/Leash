"use client";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { ResearchStatus } from "../lib/leash/research-store.ts";

/** Inline-format one line: **bold**, *italic*, [text](url), `code`. */
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${keyBase}-${i++}`;
    if (m[1] && m[2]) out.push(<a key={k} href={m[2]} target="_blank" rel="noopener noreferrer" style={{ color: "var(--color-sage-deep)", textDecoration: "underline" }}>{m[1]}</a>);
    else if (m[3]) out.push(<strong key={k}>{m[3]}</strong>);
    else if (m[4]) out.push(<em key={k}>{m[4]}</em>);
    else if (m[5]) out.push(<code key={k} style={{ fontFamily: "var(--font-mono)", fontSize: "0.85em" }}>{m[5]}</code>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Minimal markdown → React for research reports (headings, bullets, paragraphs, links). */
function ReportBody({ md }: { md: string }) {
  const lines = md.replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let bullets: string[] = [];
  const flushPara = (k: string) => {
    if (para.length) {
      blocks.push(<p key={k} style={{ margin: "0.6em 0", lineHeight: 1.65 }}>{inline(para.join(" "), k)}</p>);
      para = [];
    }
  };
  const flushBullets = (k: string) => {
    if (bullets.length) {
      blocks.push(<ul key={k} style={{ margin: "0.6em 0", paddingLeft: "1.2em", listStyle: "disc" }}>{bullets.map((b, j) => <li key={j} style={{ margin: "0.2em 0" }}>{inline(b, `${k}-${j}`)}</li>)}</ul>);
      bullets = [];
    }
  };
  lines.forEach((raw, idx) => {
    const line = raw.trimEnd();
    const k = `b${idx}`;
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (h) {
      flushPara(k); flushBullets(k);
      const level = (h[1] as string).length;
      const sz = level <= 1 ? "1.5rem" : level === 2 ? "1.25rem" : "1.05rem";
      blocks.push(<div key={k} style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: sz, margin: "1em 0 0.3em", lineHeight: 1.2 }}>{inline(h[2] as string, k)}</div>);
    } else if (bullet) {
      flushPara(k);
      bullets.push(bullet[1] as string);
    } else if (line.trim() === "---") {
      flushPara(k); flushBullets(k);
      blocks.push(<hr key={k} style={{ border: 0, borderTop: "1px solid var(--color-rule)", margin: "1.2em 0" }} />);
    } else if (line.trim() === "") {
      flushPara(k); flushBullets(k);
    } else {
      flushBullets(k);
      para.push(line);
    }
  });
  flushPara("end"); flushBullets("end");
  return <Fragment>{blocks}</Fragment>;
}

/**
 * Deep research (client) — start a run, watch live progress (poll the status file),
 * read the rendered report. Runs are detached children, so they survive dev restarts;
 * this panel just reflects their files. Online feature — needs network for web search.
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

// Human phase labels (borrowed from Odysseus's research synapse).
const PHASE_LABEL: Record<ResearchStatus["state"], string> = {
  planning: "planning strategy",
  searching: "searching the web",
  reading: "reading sources",
  synthesizing: "synthesizing findings",
  done: "complete",
  error: "error",
};

function mmss(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Live research "synapse" — a query root, one sub-node per search query, source leaves
 * fanned off the subs. Borrowed from Odysseus's researchSynapse.js, but rendered
 * deterministically from the polled status (we poll, not SSE) so it rebuilds cleanly
 * each refresh. Pulses while active, tints green when done, red on error.
 */
function Synapse({ run }: { run: ResearchStatus }) {
  const W = 520;
  const H = 230;
  const cx = W / 2;
  const cy = H / 2;
  const done = run.state === "done";
  const errored = run.state === "error";
  const accent = errored ? "var(--color-brick)" : done ? "var(--color-sage)" : "var(--color-sage-deep)";

  const subLabels = (run.queries.length ? run.queries : ["…"]).slice(0, 8);
  const nSub = subLabels.length;
  const subs = subLabels.map((label, i) => {
    const angle = (i / Math.max(6, nSub)) * Math.PI * 2 - Math.PI / 2;
    return { label, x: cx + Math.cos(angle) * 80, y: cy + Math.sin(angle) * 80, angle };
  });
  // Distribute source leaves round-robin across the subs.
  const leaves = run.sources.slice(0, 30).map((s, i) => {
    const sub = subs[i % subs.length] as (typeof subs)[number];
    const ring = Math.floor(i / subs.length / 6);
    const slot = (i / subs.length) % 6;
    const a = sub.angle + (slot - 2.5) * 0.32;
    const r = 26 + ring * 13;
    return { x: sub.x + Math.cos(a) * r, y: sub.y + Math.sin(a) * r, title: s.title || s.url };
  });

  return (
    <div className="border p-3" style={{ borderColor: "var(--color-rule)", background: "var(--color-paper)" }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" style={{ width: "100%", height: "auto", display: "block" }}>
        {/* edges: root→subs, subs→leaves */}
        {subs.map((s, i) => (
          <line key={`e${i}`} x1={cx} y1={cy} x2={s.x} y2={s.y} stroke="var(--color-rule-strong)" strokeWidth={1.2} />
        ))}
        {leaves.map((l, i) => {
          const sub = subs[i % subs.length] as (typeof subs)[number];
          return <line key={`le${i}`} x1={sub.x} y1={sub.y} x2={l.x} y2={l.y} stroke="var(--color-rule)" strokeWidth={0.8} />;
        })}
        {/* leaves */}
        {leaves.map((l, i) => (
          <circle key={`l${i}`} cx={l.x} cy={l.y} r={4} fill={accent} opacity={0.55}>
            <title>{l.title}</title>
          </circle>
        ))}
        {/* subs */}
        {subs.map((s, i) => (
          <g key={`s${i}`}>
            <circle cx={s.x} cy={s.y} r={7} fill="var(--color-paper)" stroke={accent} strokeWidth={1.8} />
            <text x={s.x + Math.cos(s.angle) * 16} y={s.y + Math.sin(s.angle) * 16 + 3} textAnchor={Math.cos(s.angle) > 0.15 ? "start" : Math.cos(s.angle) < -0.15 ? "end" : "middle"} style={{ fontFamily: "var(--font-mono)", fontSize: "8px", fill: "var(--color-faint)" }}>
              {s.label.length > 16 ? s.label.slice(0, 15) + "…" : s.label}
            </text>
          </g>
        ))}
        {/* root */}
        <circle cx={cx} cy={cy} r={11} fill={accent} />
        {!done && !errored && <circle cx={cx} cy={cy} r={11} fill="none" stroke={accent} strokeWidth={1.5} opacity={0.6}><animate attributeName="r" values="11;22" dur="1.6s" repeatCount="indefinite" /><animate attributeName="opacity" values="0.6;0" dur="1.6s" repeatCount="indefinite" /></circle>}
        <text x={cx} y={cy + 27} textAnchor="middle" style={{ fontFamily: "var(--font-body)", fontSize: "10px", fill: "var(--color-ink-soft)" }}>
          {run.question.length > 40 ? run.question.slice(0, 39) + "…" : run.question}
        </text>
      </svg>
    </div>
  );
}

/** The meta bar under the synapse: phase · round · sources · live timer. */
function MetaBar({ run }: { run: ResearchStatus }) {
  const [now, setNow] = useState(Date.now());
  const ticking = run.state !== "done" && run.state !== "error";
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);
  const elapsed = ((run.finishedAt ?? (ticking ? now : run.updatedAt)) - run.startedAt) / 1000;
  const color = run.state === "error" ? "var(--color-brick)" : run.state === "done" ? "var(--color-sage)" : "var(--color-sage-deep)";
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1" style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--color-faint)" }}>
      <span style={{ color }}>{PHASE_LABEL[run.state]}</span>
      <span>·</span>
      <span>round {run.round}/{run.maxRounds}</span>
      <span>·</span>
      <span>{run.sources.length} sources</span>
      <span>·</span>
      <span suppressHydrationWarning>{mmss(elapsed)}</span>
      {run.searchProvider && (
        <>
          <span>·</span>
          <span>{run.searchProvider}</span>
        </>
      )}
    </div>
  );
}

export function ResearchPanel({ runs, report }: { runs: ResearchStatus[]; report: { md: string; id: string } | null }) {
  const router = useRouter();
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Poll while any run is active.
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
      const res = await fetch("/api/leash/research", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question }) });
      if (!res.ok) setError(`Couldn't start research (${res.status}).`);
      else setQuestion("");
      router.refresh();
    } catch {
      setError("Request failed — is the app still running?");
    } finally {
      setBusy(false);
    }
  };

  const del = async (id: string) => {
    if (!confirm("Delete this research run and its report?")) return;
    await fetch(`/api/leash/research/${id}`, { method: "DELETE" });
    router.refresh();
  };

  // The run to visualize: the one whose report is open, else the newest active run.
  const focus = runs.find((r) => r.id === report?.id) ?? runs.find((r) => r.state !== "done" && r.state !== "error") ?? null;

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

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[0.85fr_1.15fr]">
        {/* Run list */}
        <section>
          <div className="mb-2 flex items-center gap-3">
            <span className="kicker kicker-sage">Runs</span>
            <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
          </div>
          {runs.length === 0 ? (
            <p className="kicker py-4" style={{ color: "var(--color-faint)" }}>
              No research runs yet.
            </p>
          ) : (
            <ul>
              {runs.map((r) => {
                const activeRun = r.state !== "done" && r.state !== "error";
                return (
                  <li key={r.id} className="border-b py-2.5" style={{ borderColor: "var(--color-rule)", background: report?.id === r.id ? "color-mix(in srgb, var(--color-sage) 8%, transparent)" : undefined }}>
                    <div className="flex items-start justify-between gap-2">
                      <a href={`/research?run=${r.id}`} className="min-w-0 flex-1 transition-opacity hover:opacity-70">
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
                      <button type="button" onClick={() => void del(r.id)} aria-label="Delete run" className="px-1.5 transition-opacity hover:opacity-60" style={{ color: "var(--color-faint)" }}>
                        ×
                      </button>
                    </div>
                    {r.note && (
                      <p className="kicker mt-1" style={{ color: "var(--color-faint)" }}>
                        {r.note}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Synapse + report */}
        <section>
          <div className="mb-2 flex items-center gap-3">
            <span className="kicker kicker-sage">{focus && focus.state !== "done" && focus.state !== "error" ? "In progress" : "Report"}</span>
            <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
          </div>

          {focus && (
            <div className="mb-4 flex flex-col gap-2">
              <Synapse run={focus} />
              <MetaBar run={focus} />
              {focus.note && (
                <p className="kicker" style={{ color: "var(--color-faint)" }}>
                  {focus.note}
                </p>
              )}
            </div>
          )}

          {report ? (
            <article style={{ fontFamily: "var(--font-body)", fontSize: "0.95rem", color: "var(--color-ink)" }}>
              <ReportBody md={report.md} />
            </article>
          ) : focus && focus.state !== "done" && focus.state !== "error" ? (
            <p className="kicker py-2" style={{ color: "var(--color-faint)" }}>
              The report appears here once synthesis finishes.
            </p>
          ) : (
            <p className="kicker py-4" style={{ color: "var(--color-faint)" }}>
              Select a finished run to read its report.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
