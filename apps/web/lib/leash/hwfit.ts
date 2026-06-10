/**
 * Device fit (server-only) — will a model run on THIS machine?
 *
 * The Mac has UNIFIED memory (CPU+GPU share one pool); `hw.memsize` is the whole of it. This
 * module is the SERVER half: detect that unified memory, then delegate the estimate to the pure,
 * isomorphic `model-fit.ts` (so the context-size slider in the browser re-runs the SAME math).
 *
 * Honest scope: the verdict is PER MODEL IN ISOLATION ("fits alone"). The serve holds every
 * preloaded model at once, so several "fits alone" models can still overflow together — the UI
 * says "alone" so that's not misread.
 */
import "server-only";
import { execSync } from "node:child_process";
import { totalmem } from "node:os";
import { fitFromSpec, type FitEstimate } from "./model-fit.ts";

export type { FitEstimate };

let memCache: number | null = null;

/** Total unified memory in GB (cached; 0 if undetectable). */
export function deviceMemoryGB(): number {
  if (memCache !== null) return memCache;
  let bytes = 0;
  try {
    // macOS reports unified memory via sysctl; everything else uses os.totalmem.
    bytes = process.platform === "darwin" ? Number(execSync("sysctl -n hw.memsize", { encoding: "utf8" }).trim()) : totalmem();
  } catch {
    bytes = totalmem();
  }
  if (!(bytes > 0)) bytes = totalmem();
  memCache = bytes > 0 ? bytes / 1e9 : 0;
  return memCache;
}

/**
 * Estimate peak serving memory + verdict for one model on THIS device. Thin wrapper: detect the
 * unified memory, hand the rest to the pure `fitFromSpec`. `ctx` defaults to a 4096-token window.
 */
export function estimateFit(opts: { expectedSize?: number | null; params?: string | null; quantization?: string | null; ctx?: number }): FitEstimate {
  return fitFromSpec({ deviceGB: deviceMemoryGB(), ...opts });
}
