"use client";
/**
 * Per-model context-size slider for Brain → Models. Dragging it re-estimates the device fit LIVE
 * (the same pure `fitFromSpec` the server badge uses) so the user sees the memory cost + a RAM
 * warning before committing. Saving writes `config.ctx_size` — which applies on the NEXT serve
 * restart (the serve has no live-reconfigure API), surfaced so it's never implied as instant.
 */
import { useState } from "react";
import { fitFromSpec, type FitEstimate } from "../lib/leash/model-fit.ts";

const CTX_MIN = 1024;
const CTX_STEP = 1024;
const CTX_MAX = 32768;

const FIT_COLOR: Record<NonNullable<FitEstimate["verdict"]>, string> = {
  fits: "var(--color-sage-deep)",
  tight: "#b8860b",
  "too-big": "var(--color-brick)",
};
const FIT_NOTE: Record<NonNullable<FitEstimate["verdict"]>, string> = {
  fits: "",
  tight: " · near this device's RAM",
  "too-big": " · exceeds this device's RAM",
};

export interface CtxFitRow {
  ctxSize: number | null;
  expectedSize: number | null;
  params: string | null;
  quantization: string | null;
  fit: FitEstimate;
}

export function CtxSizeControl({ row, busy, onSave }: { row: CtxFitRow; busy: boolean; onSave: (ctx: number) => void }) {
  const current = row.ctxSize ?? 4096;
  const [val, setVal] = useState(current);
  const max = Math.max(CTX_MAX, current);
  const changed = val !== current;
  const fit = fitFromSpec({ deviceGB: row.fit.deviceGB, expectedSize: row.expectedSize, params: row.params, quantization: row.quantization, ctx: val });
  const color = fit.verdict ? FIT_COLOR[fit.verdict] : "var(--color-faint)";

  return (
    <div className="flex flex-col gap-1" style={{ minWidth: 150 }}>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={CTX_MIN}
          max={max}
          step={CTX_STEP}
          value={val}
          disabled={busy}
          onChange={(e) => setVal(Number(e.target.value))}
          aria-label="Context window size in tokens"
          className="flex-1"
          style={{ accentColor: color, minWidth: 80 }}
        />
        <span className="kicker" style={{ minWidth: 48, textAlign: "right" }}>{val.toLocaleString()}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="kicker" style={{ color }} title={`≈${fit.gb} GB to serve alone · ${row.fit.deviceGB.toFixed(0)} GB unified memory`}>
          ≈{fit.gb}G{fit.verdict ? FIT_NOTE[fit.verdict] : ""}
        </span>
        {changed && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onSave(val)}
            title="Write ctx_size to qvac.config.base.json (applies on next serve restart)"
            className="ml-auto kicker border px-2 py-0.5 transition-opacity hover:opacity-70 disabled:opacity-40"
            style={{ borderColor: "var(--color-ink)" }}
          >
            save
          </button>
        )}
      </div>
      {changed && (
        <span className="kicker" style={{ color: "var(--color-faint)" }}>
          applies on next serve restart
        </span>
      )}
    </div>
  );
}
