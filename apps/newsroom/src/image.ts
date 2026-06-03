/**
 * Hero image: generated on-device with Stable Diffusion 2.1 via `@qvac/sdk`
 * `diffusion()` — no cloud, works offline once the GGUF is warm. The diffusion model
 * is loaded lazily on first use and reused across the run (it's the heaviest load).
 * SD 2.x all-in-one GGUF wants `modelConfig: { prediction: "v" }` (per the SDK's own
 * diffusion-simple example, the ground truth).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadModel, diffusion } from "@qvac/sdk";
import { prisma } from "@mycelium/db";
import { SD_V2_1_1B_Q8_0 } from "./models.ts";
import { HERO_DIR } from "./config.ts";
import { hash32 } from "./util.ts";
import type { Newsroom } from "./context.ts";

const SECTION_STYLE: Record<string, string> = {
  AI: "circuitry and neural lattice motifs",
  COMPUTE: "silicon, server racks and heat-sink geometry",
  SOLANA: "abstract ledgers, prisms and validator nodes",
  BRIEF: "a quiet domestic still life, forest understory light",
};

function heroPrompt(headline: string, section: string): string {
  const motif = SECTION_STYLE[section] ?? "abstract editorial motif";
  return (
    `Editorial newspaper illustration: ${headline}. ${motif}. ` +
    "Vintage engraving and woodcut texture, muted ink black on cream paper, sage-green accent, " +
    "broadsheet front-page art, fine cross-hatching, high detail, no text, no lettering."
  );
}

/** Generate the article's hero PNG and record its path. */
export async function makeHero(nr: Newsroom, articleId: string): Promise<void> {
  const article = await prisma.article.findUniqueOrThrow({ where: { id: articleId } });
  if (!nr.diffId) {
    nr.diffId = await loadModel({
      modelSrc: SD_V2_1_1B_Q8_0,
      modelType: "diffusion",
      modelConfig: { prediction: "v" },
      onProgress: () => {},
    });
    nr.audit.record({ event: "model_load", modelSrc: "SD_V2_1_1B_Q8_0", modelId: nr.diffId, extra: { role: "diffusion" } });
  }

  const prompt = heroPrompt(article.headline, article.section);
  const t = Date.now();
  const { outputs } = diffusion({
    modelId: nr.diffId,
    prompt,
    width: 768,
    height: 512,
    steps: 22,
    cfg_scale: 7,
    seed: hash32(articleId),
  } as Parameters<typeof diffusion>[0]);
  const buffers = await outputs;

  mkdirSync(HERO_DIR, { recursive: true });
  const file = join(HERO_DIR, `${articleId}.png`);
  writeFileSync(file, buffers[0]!);
  nr.audit.record({ event: "note", durationMs: Date.now() - t, extra: { role: "diffusion", articleId, bytes: buffers[0]!.length } });

  await prisma.article.update({
    where: { id: articleId },
    data: { heroImagePath: `/hero/${articleId}.png`, heroPrompt: prompt },
  });
}
