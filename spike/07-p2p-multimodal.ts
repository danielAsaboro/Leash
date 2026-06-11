/**
 * SP2 Phase-0 gate — can the @qvac/sdk P2P delegation carry NON-chat modalities?
 *
 * Chat is proven (spike 03). This probes embeddings / STT / TTS as DELEGATED calls against a
 * generic provider (03-p2p-provider.ts, spawned here): for each, `loadModel({ delegate,
 * fallbackToLocal:FALSE })` + the SDK call, so a delegation that the SDK can't carry FAILS
 * VISIBLY instead of silently running locally. A returned result with fallback off == the
 * provider did the work.
 *
 *   npm run spike:p2p:multimodal
 *
 * GATE: each modality that returns a correct delegated result → advertise it borrowable in SP2.
 * Each that fails → it stays "shared · local-only" (no route). Vision needs no probe — it's
 * completion()+attachments over the existing chat path.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
// QWEN3VL_2B_MULTIMODAL_Q4_K is a runtime export absent from the SDK's root .d.ts (the 0.12 gap);
// spikes run via tsx (no tsc), so the direct import resolves at runtime.
import { loadModel, unloadModel, embed, transcribe, textToSpeech, completion, close, QWEN3VL_2B_MULTIMODAL_Q4_K } from "@qvac/sdk";
import { GTE_LARGE_FP16, PARAKEET_TDT_0_6B_V3_Q8_0, TTS_EN_SUPERTONIC_Q8_0 } from "../packages/senses/src/models.ts";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const TSX = path.join(ROOT, "node_modules/.bin/tsx");
const AUDIO = ["packages/senses/scripts/fixtures/standup-2spk.wav", "data/voice/dani-backup-memo.wav"].map((p) => path.join(ROOT, p)).find(existsSync);
const IMAGE = ["spike/fixtures/ocr-note.png", "data/photos/calibration-card.png"].map((p) => path.join(ROOT, p)).find(existsSync);
/** qwen3vl's projection (mmproj) GGUF path from the serve config. RAW keeps the machine-neutral `~/`
 * form (what we'd advertise cross-machine); MMPROJ is ~-expanded for this machine. The provider loads it. */
const MMPROJ_RAW = (() => {
  try {
    const cfg = JSON.parse(readFileSync(path.join(ROOT, "qvac.config.base.json"), "utf8")) as { serve?: { models?: Record<string, { config?: { projectionModelSrc?: string } }> } };
    return cfg.serve?.models?.["qwen3vl"]?.config?.projectionModelSrc;
  } catch {
    return undefined;
  }
})();
const MMPROJ = MMPROJ_RAW ? MMPROJ_RAW.replace(/^~/, homedir()) : undefined;
const PROBE_TIMEOUT_MS = 120_000;

/** Spawn the generic delegated-inference provider and resolve once it publishes its public key. */
function startProvider(): Promise<{ publicKey: string; child: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, ["spike/03-p2p-provider.ts"], { cwd: ROOT, env: process.env });
    let out = "";
    const timer = setTimeout(() => reject(new Error("provider did not publish a key within 60s")), 60_000);
    child.stdout.on("data", (b: Buffer) => {
      out += b.toString();
      const lines = out.split("\n");
      const i = lines.findIndex((l) => l.includes("public key to the consumer"));
      if (i >= 0) {
        const key = lines.slice(i + 1).map((l) => l.trim()).find((l) => l.length >= 40);
        if (key) {
          clearTimeout(timer);
          resolve({ publicKey: key, child });
        }
      }
    });
    child.stderr.on("data", (b: Buffer) => process.stderr.write(`[provider] ${b}`));
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`provider exited early (code ${code})`));
    });
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000}s (delegation hung)`)), ms))]);
}

interface Probe {
  name: string;
  unit: string;
  run: (pk: string) => Promise<string>;
}

const delegate = (pk: string) => ({ providerPublicKey: pk, timeout: 60_000, fallbackToLocal: false });

const probes: Probe[] = [
  {
    name: "vision",
    unit: "output token",
    run: async (pk) => {
      if (!IMAGE) throw new Error("no image fixture found (spike/fixtures/ocr-note.png)");
      if (!MMPROJ || !existsSync(MMPROJ)) throw new Error(`qwen3vl projection model missing (${MMPROJ ?? "unresolved"})`);
      const noProj = Boolean(process.env["NO_PROJ"]);
      const proj = process.env["TILDE_PROJ"] ? MMPROJ_RAW : MMPROJ; // test: does the SDK expand a `~/` projection path?
      const id = await loadModel({ modelSrc: QWEN3VL_2B_MULTIMODAL_Q4_K, modelType: "llm", modelConfig: { ctx_size: 8192, ...(noProj ? {} : { projectionModelSrc: proj }) }, delegate: delegate(pk), onProgress: () => {} } as Parameters<typeof loadModel>[0]);
      try {
        const r = completion({ modelId: id, history: [{ role: "user", content: "What is in this image? Answer in one short sentence.", attachments: [{ path: IMAGE }] }], stream: true } as Parameters<typeof completion>[0]);
        let text = "";
        for await (const t of r.tokenStream) text += t;
        text = text.trim();
        if (!text) throw new Error("no tokens from delegated vision completion");
        return `"${text.slice(0, 56)}${text.length > 56 ? "…" : ""}"`;
      } finally {
        await unloadModel({ modelId: id }).catch(() => {});
      }
    },
  },
  {
    name: "embeddings",
    unit: "input token",
    run: async (pk) => {
      const id = await loadModel({ modelSrc: GTE_LARGE_FP16, modelType: "embeddings", delegate: delegate(pk), onProgress: () => {} });
      try {
        const { embedding } = await embed({ modelId: id, text: "the mesh borrows a stronger brain" });
        if (!Array.isArray(embedding) || embedding.length === 0) throw new Error("no embedding vector returned");
        return `dim=${embedding.length}`;
      } finally {
        await unloadModel({ modelId: id }).catch(() => {});
      }
    },
  },
  {
    name: "stt",
    unit: "audio second",
    run: async (pk) => {
      if (!AUDIO) throw new Error("no audio fixture found (packages/senses/scripts/fixtures/standup-2spk.wav)");
      const id = await loadModel({ modelSrc: PARAKEET_TDT_0_6B_V3_Q8_0, modelType: "parakeet", delegate: delegate(pk), onProgress: () => {} } as Parameters<typeof loadModel>[0]);
      try {
        const text = (await transcribe({ modelId: id, audioChunk: AUDIO })).trim();
        if (!text) throw new Error("empty transcript");
        return `"${text.slice(0, 56)}${text.length > 56 ? "…" : ""}"`;
      } finally {
        await unloadModel({ modelId: id }).catch(() => {});
      }
    },
  },
  {
    name: "tts",
    unit: "character",
    run: async (pk) => {
      const id = await loadModel({ modelSrc: TTS_EN_SUPERTONIC_Q8_0, modelType: "tts", modelConfig: { ttsEngine: "supertonic", language: "en", voice: "F1", ttsSpeed: 1.05, ttsNumInferenceSteps: 5 }, delegate: delegate(pk), onProgress: () => {} } as Parameters<typeof loadModel>[0]);
      try {
        const r = textToSpeech({ modelId: id, text: "Hello from the mesh.", inputType: "text", stream: false } as Parameters<typeof textToSpeech>[0]) as { buffer: Promise<{ length?: number }> };
        const pcm = await r.buffer;
        const n = pcm?.length ?? 0;
        if (!n) throw new Error("empty audio buffer");
        return `pcm samples=${n}`;
      } finally {
        await unloadModel({ modelId: id }).catch(() => {});
      }
    },
  },
];

let child: ChildProcess | undefined;
try {
  console.log("🚀 SP2 Phase-0 — probing delegated embeddings / STT / TTS (fallbackToLocal:false)\n");
  const started = await startProvider();
  child = started.child;
  console.log(`   provider key ${started.publicKey.slice(0, 16)}…  (audio fixture: ${AUDIO ? path.basename(AUDIO) : "MISSING"})\n`);

  const only = process.argv.slice(2).map((a) => a.toLowerCase()).filter((a) => !a.startsWith("-"));
  const selected = only.length ? probes.filter((p) => only.includes(p.name)) : probes;

  const results: { name: string; unit: string; ok: boolean; detail: string }[] = [];
  for (const p of selected) {
    process.stdout.write(`• ${p.name.padEnd(11)} delegated… `);
    try {
      const detail = await withTimeout(p.run(started.publicKey), PROBE_TIMEOUT_MS, p.name);
      results.push({ name: p.name, unit: p.unit, ok: true, detail });
      console.log(`GO — ${detail}`);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      results.push({ name: p.name, unit: p.unit, ok: false, detail });
      console.log(`NO-GO — ${detail}`);
    }
  }

  console.log("\n── Phase-0 delegation gate ──");
  console.log(`  ${"✅"} chat        output token   (proven — spike 03)`);
  for (const r of results) console.log(`  ${r.ok ? "✅" : "⛔"} ${r.name.padEnd(11)} ${r.unit.padEnd(13)} ${r.ok ? r.detail : `local-only — ${r.detail}`}`);
  const borrowable = ["chat", ...results.filter((r) => r.ok).map((r) => r.name)];
  console.log(`\n→ Borrowable set for SP2: ${borrowable.join(", ")}`);
  const localOnly = results.filter((r) => !r.ok).map((r) => r.name);
  if (localOnly.length) console.log(`→ Stays local-only: ${localOnly.join(", ")}`);
} catch (e) {
  console.error("❌ Phase-0 gate failed to run:", e instanceof Error ? e.message : e);
} finally {
  child?.kill("SIGINT");
  void close();
  setTimeout(() => process.exit(0), 500);
}
