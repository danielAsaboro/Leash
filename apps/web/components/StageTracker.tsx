import { STAGE_STEPS, stageIndex } from "../lib/ui.ts";

/**
 * RESEARCH → DRAFT → REVIEW → PUBLISH. Completed steps are ink, the active step is
 * sage (and pulses), upcoming steps are faint. Used on the Mission Control active
 * assignment and as a compact pill elsewhere.
 */
export function StageTracker({ stage, dark = false }: { stage: string; dark?: boolean }) {
  const active = stageIndex(stage);
  const line = dark ? "var(--color-control-line)" : "var(--color-rule)";
  return (
    <ol className="flex items-center">
      {STAGE_STEPS.map((step, i) => {
        const done = i < active;
        const isActive = i === active;
        const color = isActive
          ? "var(--color-sage)"
          : done
            ? dark
              ? "var(--color-glow)"
              : "var(--color-ink)"
            : dark
              ? "var(--color-faint)"
              : "var(--color-faint)";
        return (
          <li key={step} className="flex flex-1 items-center last:flex-none">
            <span className="flex items-center gap-2">
              <span
                className="inline-flex rounded-full"
                style={{
                  width: 9,
                  height: 9,
                  background: isActive || done ? color : "transparent",
                  border: `1.5px solid ${color}`,
                  animation: isActive ? "ping 1.8s cubic-bezier(0,0,0.2,1) infinite alternate" : undefined,
                }}
              />
              <span className="kicker" style={{ color, letterSpacing: "0.14em" }}>
                {step}
              </span>
            </span>
            {i < STAGE_STEPS.length - 1 && <span className="mx-3 h-px flex-1" style={{ background: line }} />}
          </li>
        );
      })}
    </ol>
  );
}
