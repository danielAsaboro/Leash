"use client";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { fetchWithTimeout } from "../lib/http.ts";
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
 * fanned off the subs. Rendered deterministically from the polled status so it rebuilds
 * cleanly each refresh. Pulses while active, tints green when done, red on error.
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
        {subs.map((s, i) => (
          <line key={`e${i}`} x1={cx} y1={cy} x2={s.x} y2={s.y} stroke="var(--color-rule-strong)" strokeWidth={1.2} />
        ))}
        {leaves.map((l, i) => {
          const sub = subs[i % subs.length] as (typeof subs)[number];
          return <line key={`le${i}`} x1={sub.x} y1={sub.y} x2={l.x} y2={l.y} stroke="var(--color-rule)" strokeWidth={0.8} />;
        })}
        {leaves.map((l, i) => (
          <circle key={`l${i}`} cx={l.x} cy={l.y} r={4} fill={accent} opacity={0.55}>
            <title>{l.title}</title>
          </circle>
        ))}
        {subs.map((s, i) => (
          <g key={`s${i}`}>
            <circle cx={s.x} cy={s.y} r={7} fill="var(--color-paper)" stroke={accent} strokeWidth={1.8} />
            <text x={s.x + Math.cos(s.angle) * 16} y={s.y + Math.sin(s.angle) * 16 + 3} textAnchor={Math.cos(s.angle) > 0.15 ? "start" : Math.cos(s.angle) < -0.15 ? "end" : "middle"} style={{ fontFamily: "var(--font-mono)", fontSize: "8px", fill: "var(--color-faint)" }}>
              {s.label.length > 16 ? s.label.slice(0, 15) + "…" : s.label}
            </text>
          </g>
        ))}
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

/**
 * One research run's detail view — synapse + live meta + rendered report, plus per-run
 * cancel/delete. Polls itself (router.refresh) while the run is active. Rendered by
 * /research/[id]; the run list lives in ResearchList.
 */
export function ResearchDetail({ run, report }: { run: ResearchStatus; report: string | null }) {
  const router = useRouter();
  const active = run.state !== "done" && run.state !== "error";
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(t);
  }, [active, router]);

  const cancel = async () => {
    if (!confirm("Cancel this research run? Anything gathered so far is kept; if a model call is mid-decode the worker finishes it first (a few seconds).")) return;
    await fetchWithTimeout(`/api/leash/research/${run.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "cancel" }) });
    router.refresh();
  };
  const del = async () => {
    if (!confirm("Delete this research run and its report?")) return;
    await fetchWithTimeout(`/api/leash/research/${run.id}`, { method: "DELETE" });
    router.push("/services/research");
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <a href="/services/research" className="kicker transition-opacity hover:opacity-70" style={{ color: "var(--color-sage-deep)" }}>← All research</a>
        <span className="flex items-center gap-2">
          {active && <button type="button" onClick={() => void cancel()} className="kicker px-2 transition-opacity hover:opacity-60" style={{ color: "var(--color-brick)" }}>Cancel</button>}
          <button type="button" onClick={() => void del()} className="kicker px-2 transition-opacity hover:opacity-60" style={{ color: "var(--color-faint)" }}>Delete</button>
        </span>
      </div>
      <h2 style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "1.4rem" }}>{run.question}</h2>
      <Synapse run={run} />
      <MetaBar run={run} />
      {run.note && <p className="kicker" style={{ color: "var(--color-faint)" }}>{run.note}</p>}
      {report ? (
        <article style={{ fontFamily: "var(--font-body)", fontSize: "0.95rem", color: "var(--color-ink)" }}><ReportBody md={report} /></article>
      ) : active ? (
        <p className="kicker py-2" style={{ color: "var(--color-faint)" }}>The report appears here once synthesis finishes.</p>
      ) : (
        <p className="kicker py-4" style={{ color: "var(--color-faint)" }}>No report for this run.</p>
      )}
    </div>
  );
}
