/**
 * Growth-chart data source — Layer 4 ("The Understory").
 *
 * Reads the evolution loop's evidence straight off disk: the append-only scored
 * runs (`data/evolve/eval-runs.jsonl`) and the newest adapter's `manifest.json`.
 * Both are PLAIN files — the web process never opens a corestore (the registry is
 * single-process / fd-locked; see CLAUDE.md), so reading these can't wedge a serve.
 *
 * Types are redefined locally (the house pattern in graph.ts) so the web bundle
 * never pulls @mycelium/memory → @qvac/sdk into the client.
 */
import "server-only";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** apps/web/lib/leash → repo root → data (same resolution as graph.ts). */
const DATA_DIR = process.env["LEASH_DATA_DIR"] ?? join(here, "..", "..", "..", "..", "data");
const EVAL_RUNS_FILE = join(DATA_DIR, "evolve", "eval-runs.jsonl");
const ADAPTERS_DIR = join(DATA_DIR, "adapters");

export interface AxisScore {
  axis: string;
  score: number;
  total: number;
  passed: number;
}
export interface EvalRun {
  ts: string;
  label: string;
  model: string;
  adapterPath?: string;
  axes: AxisScore[];
  overall: number;
}
export interface AdapterManifest {
  version: string;
  baseModel: string;
  adapterFile: string;
  sha256: string;
  sizeBytes: number;
  trainPairs: number;
  createdAt: string;
  base: EvalRun;
  adapter: EvalRun;
  evalDelta: number;
}

/** One charted round: adapter overall vs the base it was measured against. */
export interface SeriesPoint {
  ts: string;
  version: string;
  base: number;
  adapter: number;
  axes: { axis: string; base: number; adapter: number }[];
}

export interface AxisDelta {
  axis: string;
  base: number;
  adapter: number;
  delta: number;
}

export interface GrowthSeries {
  points: SeriesPoint[];
  latest: AdapterManifest | null;
  axisDeltas: AxisDelta[];
  hasData: boolean;
}

/** Lenient per-line JSONL read ([] on missing/garbled file). */
function readEvalRuns(): EvalRun[] {
  let raw: string;
  try {
    raw = readFileSync(EVAL_RUNS_FILE, "utf-8");
  } catch {
    return [];
  }
  const out: EvalRun[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const r = JSON.parse(s) as EvalRun;
      if (r && Array.isArray(r.axes) && typeof r.overall === "number") out.push(r);
    } catch {
      /* skip a torn line */
    }
  }
  return out;
}

const axisScore = (run: EvalRun, axis: string): number => run.axes.find((a) => a.axis === axis)?.score ?? 0;

/** Newest adapter manifest on disk (versions sort lexicographically = chronologically). */
function latestManifest(): AdapterManifest | null {
  if (!existsSync(ADAPTERS_DIR)) return null;
  let best: AdapterManifest | null = null;
  let bestVersion = "";
  for (const version of readdirSync(ADAPTERS_DIR)) {
    const manifestPath = join(ADAPTERS_DIR, version, "manifest.json");
    try {
      if (!statSync(manifestPath).isFile()) continue;
      const m = JSON.parse(readFileSync(manifestPath, "utf-8")) as AdapterManifest;
      if (version > bestVersion) {
        bestVersion = version;
        best = m;
      }
    } catch {
      /* skip a corrupt/absent manifest */
    }
  }
  return best;
}

/** Pair every adapter run with the base run that preceded it → the growth trajectory. */
export function buildSeries(): GrowthSeries {
  const runs = readEvalRuns();
  const points: SeriesPoint[] = [];
  let lastBase: EvalRun | undefined;
  for (const r of runs) {
    if (r.label === "base") {
      lastBase = r;
      continue;
    }
    const axes = r.axes.map((a) => ({ axis: a.axis, base: lastBase ? axisScore(lastBase, a.axis) : 0, adapter: a.score }));
    points.push({ ts: r.ts, version: r.label, base: lastBase ? lastBase.overall : 0, adapter: r.overall, axes });
  }

  const latest = latestManifest();
  const axisDeltas: AxisDelta[] = latest
    ? latest.adapter.axes.map((a) => {
        const base = latest.base.axes.find((b) => b.axis === a.axis)?.score ?? 0;
        return { axis: a.axis, base, adapter: a.score, delta: a.score - base };
      })
    : [];

  return { points, latest, axisDeltas, hasData: points.length > 0 || latest !== null };
}
