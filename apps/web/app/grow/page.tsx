/**
 * `/grow` — the growth chart. "Yesterday it didn't know this about me; after last
 * night's on-device LoRA, it does." Reads the frozen-eval scores + latest adapter
 * manifest off disk (no model, no corestore) and shows whether the nightly LoRA is
 * measurably getting better at you — per axis, with every run logged (not cherry-picked).
 */
import { buildSeries } from "../../lib/leash/evolve.ts";
import { DashShell, DashCard, Stat, Row } from "../../components/dash.tsx";
import { GrowthChart } from "../../components/GrowthChart.tsx";

export const dynamic = "force-dynamic";

const fmtDelta = (d: number): string => `${d >= 0 ? "+" : ""}${d.toFixed(3)}`;
const pct = (v: number): string => `${Math.round(v * 100)}%`;
const AXIS_LABEL: Record<string, string> = { recall: "Personal-fact recall", preference: "Preference adherence", style: "Style match" };

export default async function GrowPage() {
  const series = buildSeries();
  const { latest, axisDeltas } = series;
  const points = series.points.map((p) => ({ version: p.version, base: p.base, adapter: p.adapter }));

  return (
    <DashShell
      kicker="Leash · Memory"
      title="Growth"
      lede="Is it getting better at you? The nightly on-device LoRA, measured on a fixed, frozen eval — every run logged, nothing cherry-picked."
    >
      {!series.hasData ? (
        <DashCard title="The Understory">
          <p className="italic" style={{ color: "var(--color-muted)", fontFamily: "var(--font-body)" }}>
            No adapter trained yet. Run <code style={{ fontFamily: "var(--font-mono)" }}>npm run evolve</code> (or wait for the 03:30 nightly job) to
            curate your signals, fine-tune a LoRA adapter, and score it against the frozen eval set. The first round will appear here.
          </p>
        </DashCard>
      ) : (
        <div className="flex flex-col gap-5">
          {latest && (
            <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
              <Stat label="Overall Δ vs base" value={fmtDelta(latest.evalDelta)} accent={latest.evalDelta >= 0} />
              <Stat label="Training pairs" value={latest.trainPairs} />
              <Stat label="Adapter" value={latest.version} />
              <Stat label="Size" value={`${(latest.sizeBytes / 1e6).toFixed(1)} MB`} />
            </div>
          )}

          <DashCard title="Better at you — base vs adapter">
            <GrowthChart points={points} />
          </DashCard>

          {axisDeltas.length > 0 && (
            <DashCard title="Latest adapter — per axis">
              {axisDeltas.map((a) => (
                <Row
                  key={a.axis}
                  label={AXIS_LABEL[a.axis] ?? a.axis}
                  value={
                    <span>
                      {pct(a.base)} → <strong style={{ color: a.delta >= 0 ? "var(--color-sage-deep)" : "var(--color-brick)" }}>{pct(a.adapter)}</strong>{" "}
                      ({fmtDelta(a.delta)})
                    </span>
                  }
                />
              ))}
            </DashCard>
          )}

          {latest && (
            <DashCard title="Adapter manifest">
              <Row label="Version" value={latest.version} />
              <Row label="Base model" value={latest.baseModel} />
              <Row label="Trained on" value={`${latest.trainPairs} pairs`} />
              <Row label="eval Δ (overall)" value={<span style={{ color: latest.evalDelta >= 0 ? "var(--color-sage-deep)" : "var(--color-brick)" }}>{fmtDelta(latest.evalDelta)}</span>} />
              <Row label="Promotable" value={latest.evalDelta >= 0 ? "yes — clears the bar" : "no — regression, not promoted"} />
              <Row label="sha256" value={latest.sha256.slice(0, 16) + "…"} />
              <Row label="Created" value={new Date(latest.createdAt).toLocaleString()} />
            </DashCard>
          )}
        </div>
      )}
    </DashShell>
  );
}
