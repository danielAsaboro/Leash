/**
 * `npm run evolve` — the full nightly loop: curate → train → eval(base+adapter) →
 * manifest. Heavy GPU op (runs the 4B LoRA); the nightly cron fires this at idle.
 *
 *   npm run evolve
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuditLog } from "@mycelium/shared";
import { runNightlyLora } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const audit = new AuditLog("memory-evolve", join(here, "..", "logs"));

try {
  console.log("=== 🌱 evolve — nightly LoRA loop (Layer 4) ===\n");
  const outcome = await runNightlyLora({ audit });

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
