"use client";
/**
 * Per-model CPU ⇄ GPU compute toggle for Brain → Models. Writes `config.use_gpu` (true = GPU,
 * false = CPU) via models/config — applies on the NEXT serve restart. `null` = unset, shown as the
 * SDK default (GPU on Apple Silicon / Metal); "save" only appears once the choice actually differs.
 */
import { useState } from "react";

export function GpuToggle({ useGpu, busy, onSave }: { useGpu: boolean | null; busy: boolean; onSave: (useGpu: boolean) => void }) {
  const saved = useGpu ?? true; // null = SDK default (GPU on Metal)
  const [val, setVal] = useState<boolean>(saved);
  const changed = val !== saved;

  const seg = (on: boolean, label: string) => (
    <button
      type="button"
      disabled={busy}
      onClick={() => setVal(on)}
      aria-pressed={val === on}
      className="kicker px-2 py-0.5 transition-opacity hover:opacity-80 disabled:opacity-40"
      style={{ background: val === on ? "var(--color-sage-deep)" : "transparent", color: val === on ? "var(--color-cream)" : "var(--color-ink-soft)" }}
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-col gap-1" style={{ minWidth: 88 }}>
      <div className="inline-flex border" style={{ borderColor: "var(--color-sage-deep)", width: "fit-content" }}>
        {seg(false, "CPU")}
        {seg(true, "GPU")}
      </div>
      {useGpu === null && !changed && <span className="kicker" style={{ color: "var(--color-faint)" }}>default</span>}
      {changed && (
        <button
          type="button"
          disabled={busy}
          onClick={() => onSave(val)}
          title="Write use_gpu to qvac.config.base.json (applies on next serve restart)"
          className="kicker border px-2 py-0.5 transition-opacity hover:opacity-70 disabled:opacity-40"
          style={{ borderColor: "var(--color-sage-deep)", width: "fit-content" }}
        >
          save · restart
        </button>
      )}
    </div>
  );
}
