/**
 * A tiny hand-rolled cumulative sparkline — inline SVG, no chart lib (matches the broadsheet's
 * GrowthChart idiom). Server-renderable. Draws a faint area under a stroked line with an end dot;
 * a flat rule when there's no data yet, so the ledger never shows an empty box.
 */
export function Sparkline({
  values,
  color,
  width = 120,
  height = 30,
}: {
  values: readonly number[];
  color: string;
  width?: number;
  height?: number;
}) {
  const pad = 2;
  const baseline = height - pad;
  if (values.length === 0) {
    return (
      <svg width={width} height={height} aria-hidden className="block">
        <line x1={0} y1={baseline} x2={width} y2={baseline} stroke="var(--color-rule)" strokeWidth={1} strokeDasharray="2 3" />
      </svg>
    );
  }
  const max = Math.max(...values, 1);
  const n = values.length;
  const x = (i: number): number => (n === 1 ? width : (i / (n - 1)) * width);
  const y = (v: number): number => baseline - (v / max) * (height - pad * 2);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const line = n === 1 ? `0,${y(values[0]!).toFixed(1)} ${pts[0]}` : pts.join(" ");
  const area = `0,${baseline} ${line} ${width},${baseline}`;
  const last = values[n - 1]!;
  return (
    <svg width={width} height={height} aria-hidden className="block">
      <polygon points={area} fill={color} fillOpacity={0.1} />
      <polyline points={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={width} cy={y(last)} r={2.2} fill={color} />
    </svg>
  );
}
