/**
 * `npm run evolve` — the full nightly loop: curate → train → eval(base+adapter) →
 * manifest. Heavy GPU op; the nightly cron fires this at idle.
 *
 *   npm run evolve
 *
 * Base model: the trainable QWEN3_600M_INST_Q4 by default. To train a BIGGER model
 * (the only path >4B, since the catalog's 4B/8B/20B all ship as un-finetunable Q4_K_M),
 * drop a trainable-quant gguf (Q4_0/Q8_0/F16) in ~/.qvac/models and point at it:
 *
 *   MYCELIUM_LORA_BASE_GGUF=~/.qvac/models/Qwen3-8B-Q8_0.gguf \
 *   MYCELIUM_LORA_BASE_NAME=qwen3-8b MYCELIUM_LORA_EPOCHS=5 npm run evolve
 *
 * Epoch count is MYCELIUM_LORA_EPOCHS (default 5; the 600M scored 0% recall at 2 — the
 * bigger base + more passes is the recall bet). The root `evolve` npm script defaults
 * all three so the nightly cron inherits them.
 *
 * The adapter then applies to a served Qwen3-8B (LoRA carries across quants — serve the
 * catalog's Q4_K_M 8B and load the adapter via config.lora; set LEASH_CHAT_MODEL=qwen3-8b-me).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuditLog } from "@mycelium/shared";
import { runNightlyLora, type TrainBase, type AdapterManifest, type PromoteResult } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const audit = new AuditLog("memory-evolve", join(here, "..", "logs"));
/** packages/memory/scripts → repo root → data/leash-tasks.json (the shared task store). */
const TASKS_FILE = process.env["LEASH_TASKS_FILE"] ?? join(here, "..", "..", "..", "data", "leash-tasks.json");

/** A task row in the shared store (mirrors apps/web lib/leash/tasks-store.ts). */
interface TaskRow {
  id: string;
  title: string;
  detail?: string;
  status: string;
  priority: string;
  tags: string[];
  source: string;
  chatIds: string[];
  createdAt: number;
  updatedAt: number;
}

/** Surface a promotable nightly adapter on the /tasks dashboard — the otherwise-invisible "it
 *  learned overnight" work, made into ONE actionable card. Replaces any still-open prior
 *  nightly-learning task so the list shows last night's result, not a month of them (done/dropped
 *  ones stay as history). Lenient read + atomic tmp/rename (dream.mts discipline); best-effort —
 *  never fails the evolve run. */
function upsertEvolveTask(m: AdapterManifest, served?: PromoteResult): void {
  try {
    let tasks: TaskRow[] = [];
    try {
      const raw = JSON.parse(readFileSync(TASKS_FILE, "utf8"));
      if (Array.isArray(raw)) tasks = raw as TaskRow[];
    } catch {
      /* missing/garbled → start fresh */
    }
    tasks = tasks.filter((t) => !(t && t.source === "evolve" && (t.status === "open" || t.status === "in_progress")));
    const now = Date.now();
    const deltas = m.adapter.axes
      .map((a) => {
        const base = m.base.axes.find((b) => b.axis === a.axis)?.score ?? 0;
        const d = a.score - base;
        return `${a.axis} ${d >= 0 ? "+" : ""}${d.toFixed(2)}`;
      })
      .join(", ");
    const activate = served ? ` Activate: set LEASH_CHAT_MODEL=${served.aliasName} and reload the serve.` : "";
    tasks.push({
      id: `evolve-${now}`,
      title: `🌱 Nightly learning: adapter ${m.version} is better at you`,
      detail: `Last night's on-device LoRA shipped a promotable adapter (overall ${m.evalDelta >= 0 ? "+" : ""}${m.evalDelta.toFixed(3)}; per-axis ${deltas}). See the climb at /brain?tab=growth.${activate}`.slice(0, 1000),
      status: "open",
      priority: "normal",
      tags: ["nightly-learning"],
      source: "evolve",
      chatIds: [],
      createdAt: now,
      updatedAt: now,
    });
    mkdirSync(dirname(TASKS_FILE), { recursive: true });
    const tmp = join(dirname(TASKS_FILE), `.evolve-task-${now}.tmp`);
    writeFileSync(tmp, JSON.stringify(tasks, null, 2));
    renameSync(tmp, TASKS_FILE);
    console.log(`📝 task added: nightly-learning result → ${TASKS_FILE}`);
  } catch (err) {
    console.error("evolve: could not add task:", err);
  }
}

/** Optional custom base gguf (the >4B path) — expands a leading ~/ to this machine's home. */
function customBase(): TrainBase | undefined {
  const raw = process.env["MYCELIUM_LORA_BASE_GGUF"];
  if (!raw) return undefined;
  const src = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
  return { src, name: process.env["MYCELIUM_LORA_BASE_NAME"] ?? `custom:${basename(src)}` };
}

try {
  console.log("=== 🌱 evolve — nightly LoRA loop (Layer 4) ===\n");
  const base = customBase();
  if (base) console.log(`base override: ${base.name} (${base.src})\n`);
  const epochsRaw = Number(process.env["MYCELIUM_LORA_EPOCHS"] ?? 5);
  const epochs = Number.isFinite(epochsRaw) && epochsRaw > 0 ? Math.floor(epochsRaw) : 5;
  console.log(`epochs: ${epochs}\n`);
  const outcome = await runNightlyLora({ audit, epochs, ...(base ? { base } : {}) });

  if (outcome.skipped) {
    console.log(`\n⏭️  skipped: ${outcome.reason}`);
    console.log(`   sources: ${JSON.stringify(outcome.curate.counts.bySource)}`);
    console.log(`   Add more memories/feedback and re-run. Log: ${audit.path}`);
  } else {
    const m = outcome.manifest!;
    console.log(`\n📦 adapter ${m.version} (${(m.sizeBytes / 1e6).toFixed(1)} MB, ${m.trainPairs} pairs)`);
    console.log(`   base    overall: ${m.base.overall.toFixed(3)}  [${m.base.axes.map((a) => `${a.axis}=${a.score.toFixed(2)}`).join(" ")}]`);
    console.log(`   adapter overall: ${m.adapter.overall.toFixed(3)}  [${m.adapter.axes.map((a) => `${a.axis}=${a.score.toFixed(2)}`).join(" ")}]`);
    console.log(`   evalDelta: ${m.evalDelta >= 0 ? "+" : ""}${m.evalDelta.toFixed(3)} → ${m.evalDelta >= 0 ? "🟢 PROMOTABLE" : "🔴 regression (not promoted)"}`);
    if (outcome.served) {
      console.log(`\n🪄 serve alias written: ${outcome.served.aliasName} → ${outcome.served.loraConfigValue}`);
      console.log(`   Activate on the web chat:  export LEASH_CHAT_MODEL=${outcome.served.aliasName}`);
      console.log(`   Then RELOAD the serve (dashboard Force-restart) — never kill a live worker.`);
    } else if (m.evalDelta >= 0) {
      console.log(`\n   (base ${m.baseModel} isn't the served chat model — apply via the edge/council loadModel({lora}) path)`);
    }
    // Surface a promotable nightly adapter as one actionable task (the "it learned overnight" moment).
    if (m.evalDelta >= 0) upsertEvolveTask(m, outcome.served);
    console.log(`\n✅ Log: ${audit.path}`);
  }
} catch (error) {
  console.error("❌ evolve failed:", error);
  audit.record({ event: "note", extra: { role: "evolve", error: String(error) } });
  process.exitCode = 1;
}
