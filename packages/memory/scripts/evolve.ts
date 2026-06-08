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
 *   MYCELIUM_LORA_BASE_NAME=qwen3-8b npm run evolve
 *
 * The adapter then applies to a served Qwen3-8B (LoRA carries across quants — serve the
 * catalog's Q4_K_M 8B and load the adapter via config.lora; set LEASH_CHAT_MODEL=qwen3-8b-me).
 */
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuditLog } from "@mycelium/shared";
import { runNightlyLora, type TrainBase } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const audit = new AuditLog("memory-evolve", join(here, "..", "logs"));

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
  const outcome = await runNightlyLora({ audit, ...(base ? { base } : {}) });

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
    console.log(`\n✅ Log: ${audit.path}`);
  }
} catch (error) {
  console.error("❌ evolve failed:", error);
  audit.record({ event: "note", extra: { role: "evolve", error: String(error) } });
  process.exitCode = 1;
}
