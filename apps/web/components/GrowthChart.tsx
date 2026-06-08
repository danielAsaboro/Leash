"use client";

/**
 * The growth chart — "better at you" over time. Inline SVG, no chart library:
 *   · dashed grey polyline = the BASE model's overall score (flat — it never learns)
 *   · solid sage polyline  = the ADAPTER's overall score (rising as it learns you)
 * Each adapter point hovers (<title>) with its version + score. `motion` draws the
 * adapter line in on entrance. Uses the paper theme's CSS tokens.
 */
import { motion } from "motion/react";

export interface ChartPoint {
  version: string;
  base: number;
  adapter: number;
}

const W = 640;
const H = 240;
const PAD = { l: 36, r: 16, t: 16, b: 30 };
const plotW = W - PAD.l - PAD.r;
const plotH = H - PAD.t - PAD.b;

const x = (i: number, n: number): number => (n <= 1 ? PAD.l + plotW / 2 : PAD.l + (i / (n - 1)) * plotW);
const y = (v: number): number => PAD.t + (1 - Math.max(0, Math.min(1, v))) * plotH;

export function GrowthChart({ points }: { points: ChartPoint[] }) {
  if (points.length === 0) {
    return (
      <p className="italic" style={{ color: "var(--color-faint)", fontFamily: "var(--font-body)" }}>
        No adapter trained yet — run <code style={{ fontFamily: "var(--font-mono)" }}>npm run evolve</code> to plot the first round.
      </p>
    );
  }
  const n = points.length;
  const baseLine = points.map((p, i) => `${x(i, n)},${y(p.base)}`).join(" ");
  const adapterLine = points.map((p, i) => `${x(i, n)},${y(p.adapter)}`).join(" ");

  return (
    <div style={{ width: "100%", overflowX: "auto" }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Model growth over time: base vs adapter overall score" style={{ maxWidth: W }}>
        {/* y gridlines + labels at 0 / 0.5 / 1.0 */}
        {[0, 0.5, 1].map((g) => (
          <g key={g}>
            <line x1={PAD.l} y1={y(g)} x2={W - PAD.r} y2={y(g)} stroke="var(--color-rule)" strokeWidth={1} strokeDasharray="2 3" />
            <text x={PAD.l - 6} y={y(g) + 3} textAnchor="end" fontSize={9} fontFamily="var(--font-mono)" fill="var(--color-faint)">
              {g.toFixed(1)}
            </text>
          </g>
        ))}

        {/* base (dashed grey, static) */}
        <polyline points={baseLine} fill="none" stroke="var(--color-faint)" strokeWidth={1.5} strokeDasharray="5 4" />
        {/* adapter (solid sage, drawn in) */}
        <motion.polyline
          points={adapterLine}
          fill="none"
          stroke="var(--color-sage-deep)"
          strokeWidth={2.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          initial={{ pathLength: 0, opacity: 0.3 }}
          animate={{ pathLength: 1, opacity: 1 }}
          transition={{ duration: 0.9, ease: "easeOut" }}
        />

        {/* markers — base (small) + adapter (filled, hoverable) */}
        {points.map((p, i) => (
          <g key={p.version}>
            <circle cx={x(i, n)} cy={y(p.base)} r={2.5} fill="var(--color-faint)" />
            <motion.circle
              cx={x(i, n)}
              cy={y(p.adapter)}
              r={3.5}
              fill="var(--color-sage-deep)"
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: 0.3 + i * 0.06 }}
            >
              <title>{`${p.version}: adapter ${p.adapter.toFixed(3)} vs base ${p.base.toFixed(3)} (${p.adapter - p.base >= 0 ? "+" : ""}${(p.adapter - p.base).toFixed(3)})`}</title>
            </motion.circle>
          </g>
        ))}

        {/* x labels: first + last version (compact) */}
        {[0, n - 1].filter((i, idx, a) => a.indexOf(i) === idx).map((i) => (
          <text key={i} x={x(i, n)} y={H - 10} textAnchor={n <= 1 ? "middle" : i === 0 ? "start" : "end"} fontSize={9} fontFamily="var(--font-mono)" fill="var(--color-faint)">
            {points[i]?.version ?? ""}
          </text>
        ))}
      </svg>

      <div className="mt-1 flex items-center gap-4" style={{ fontFamily: "var(--font-mono)", fontSize: "0.6rem", color: "var(--color-faint)", letterSpacing: "0.06em" }}>
        <span className="inline-flex items-center gap-1">
          <span aria-hidden style={{ display: "inline-block", width: 18, borderTop: "1.5px dashed var(--color-faint)" }} /> base
        </span>
        <span className="inline-flex items-center gap-1">
          <span aria-hidden style={{ display: "inline-block", width: 18, borderTop: "2.5px solid var(--color-sage-deep)" }} /> adapter (you)
        </span>
      </div>
    </div>
  );
}
