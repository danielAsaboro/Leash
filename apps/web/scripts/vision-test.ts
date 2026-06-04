/**
 * PROOF: on-device vision via the NATIVE @qvac/sdk completion + attachments path
 * (the documented image-input route the HTTP serve doesn't expose).
 *
 *   npx tsx apps/web/scripts/vision-test.ts <image-path>
 */
import { loadModel, completion, unloadModel, close } from "@qvac/sdk";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env["HOME"] ?? "";
const VL_BASE = join(HOME, ".qvac/models/8541490f11509b11_Qwen3VL-2B-Instruct-Q4_K_M.gguf");
const VL_MMPROJ = join(HOME, ".qvac/models/a268510e9b1f22c9_mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf");

function pickImage(): string {
  if (process.argv[2] && existsSync(process.argv[2])) return process.argv[2];
  const dir = join(process.cwd(), "apps/web/public/leash-gen");
  const png = existsSync(dir) ? readdirSync(dir).find((f) => f.endsWith(".png")) : undefined;
  if (png) return join(dir, png);
  throw new Error("no image: pass a path or generate one first");
}

async function main(): Promise<void> {
  const image = pickImage();
  console.log(`🖼  image: ${image}`);
  console.log(`📦 loading qwen3vl (base + mmproj)…`);
  const modelId = await loadModel({
    modelSrc: VL_BASE,
    modelType: "llamacpp-completion",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    modelConfig: { ctx_size: 4096, projectionModelSrc: VL_MMPROJ } as any,
    onProgress: () => {},
  });
  console.log(`👁  describing the image…\n`);
  const run = completion({
    modelId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    history: [{ role: "user", content: "Describe this image in one sentence.", attachments: [{ path: image }] }] as any,
    stream: true,
    generationParams: { predict: 200 },
  });
  let out = "";
  for await (const t of run.tokenStream) {
    out += t;
    process.stdout.write(t);
  }
  console.log(`\n\n${out.trim() ? "✅ VISION WORKS (native path)" : "❌ empty — still no image grounding"}`);
  await unloadModel({ modelId });
  await close();
}

main().catch((err) => {
  console.error("❌ vision-test failed:", err);
  process.exit(1);
});
