import type { AdapterManifest, EvalAxis } from "./types.ts";

/** Require a visible held-out gain before an adapter can replace the base model. */
export const MIN_ADAPTER_EVAL_DELTA = 0.02;
/** Allow small judge noise, but reject an adapter that materially harms any axis. */
export const MAX_ADAPTER_AXIS_REGRESSION = 0.02;

export interface AdapterQualityOptions {
  minDelta?: number;
  maxAxisRegression?: number;
}

export interface AdapterAxisDelta {
  axis: EvalAxis;
  base: number;
  adapter: number;
  delta: number;
}

export interface AdapterQualityDecision {
  passed: boolean;
  minDelta: number;
  maxAxisRegression: number;
  overallDelta: number;
  axes: AdapterAxisDelta[];
  reasons: string[];
}

/** Derive the promotion decision from frozen held-out scores; never trust a label alone. */
export function evaluateAdapterQuality(
  manifest: AdapterManifest,
  options: AdapterQualityOptions = {},
): AdapterQualityDecision {
  const minDelta = options.minDelta ?? MIN_ADAPTER_EVAL_DELTA;
  const maxAxisRegression = options.maxAxisRegression ?? MAX_ADAPTER_AXIS_REGRESSION;
  const reasons: string[] = [];
  const baseAxes = new Map(manifest.base.axes.map((axis) => [axis.axis, axis.score]));
  const axes: AdapterAxisDelta[] = manifest.adapter.axes.map((axis) => {
    const base = baseAxes.get(axis.axis);
    if (base === undefined) {
      reasons.push(`missing base score for ${axis.axis}`);
      return { axis: axis.axis, base: 0, adapter: axis.score, delta: axis.score };
    }
    return { axis: axis.axis, base, adapter: axis.score, delta: axis.score - base };
  });

  for (const axis of manifest.base.axes) {
    if (!manifest.adapter.axes.some((candidate) => candidate.axis === axis.axis)) {
      reasons.push(`missing adapter score for ${axis.axis}`);
    }
  }
  if (manifest.base.model !== manifest.baseModel || manifest.adapter.model !== manifest.baseModel) {
    reasons.push("base and adapter evaluations must use the manifest base model");
  }
  if (manifest.evalDelta < minDelta) {
    reasons.push(`overall held-out delta ${manifest.evalDelta.toFixed(4)} is below ${minDelta.toFixed(4)}`);
  }
  for (const axis of axes) {
    if (axis.delta < -maxAxisRegression) {
      reasons.push(`${axis.axis} regressed ${Math.abs(axis.delta).toFixed(4)}, above the ${maxAxisRegression.toFixed(4)} limit`);
    }
  }

  return {
    passed: reasons.length === 0,
    minDelta,
    maxAxisRegression,
    overallDelta: manifest.evalDelta,
    axes,
    reasons,
  };
}
