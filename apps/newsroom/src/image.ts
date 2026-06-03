/**
 * Hero image: generated on-device with `@qvac/sdk` `diffusion()` — no cloud, works
 * offline once the GGUFs are warm. The model is loaded lazily on first use and reused
 * across the run (it's the heaviest load).
 *
 * 0.12.0 flagship: **FLUX.2 [klein]** (Metal "matches MLX"). Flux is a *split-layout,
 * flow-matching* model — the diffusion GGUF is the `modelSrc`, and the LLM text-encoder
 * + VAE are passed via `modelConfig.{llmModelSrc,vaeModelSrc}`. Unlike SD 2.x it does
 * **not** take `prediction: "v"`; it uses `guidance` + a low `cfg_scale` (per the SDK's
 * own `diffusion-flux2-klein` example, the ground truth). `SD_V2_1_1B_Q8_0` stays the
 * exported fallback engine.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadModel, diffusion } from "@qvac/sdk";
import { prisma } from "@mycelium/db";
import { FLUX_2_KLEIN_4B_Q4_0, FLUX_2_KLEIN_4B_VAE, QWEN3_4B_Q4_K_M } from "./models.ts";
import { HERO_DIR } from "./config.ts";
import { hash32 } from "./util.ts";
import { complete, type Newsroom } from "./context.ts";

const SECTION_STYLE: Record<string, string> = {
  AI: "circuitry and neural lattice motifs",
  COMPUTE: "silicon, server racks and heat-sink geometry",
  SOLANA: "abstract ledgers, prisms and validator nodes",
  BRIEF: "a quiet domestic still life, forest understory light",
};

/**
 * Flux2 (unlike SD 2.x) **typesets any literal text it sees in the prompt** — feeding the
 * raw headline made it render a garbled faux-masthead full of the brand names + numbers
 * the headline contains. So we first ask the council LLM (already loaded) to distil the
 * headline into a *wordless* visual scene — concrete objects/symbols/metaphors only, with
 * brand names and digits stripped — and use that as the subject. Falls back to a generic
 * section descriptor if the model is unavailable or echoes lettering-prone tokens.
 */
async function heroSubject(nr: Newsroom, headline: string, section: string): Promise<string> {
  const generic = `${section.toLowerCase()} news`;
  if (!nr.llmId) return generic; // no council loaded (e.g. isolated tests) → safe generic subject
  const sys =
    "Turn a news headline into a SHORT wordless visual scene for an engraved newspaper illustration. " +
    "Reply with ONE concise phrase (max 16 words) of concrete objects, symbols and metaphors only. " +
    "NO brand or product names, NO numbers or digits, NO quoted words — nothing that would be lettered into the image.";
  try {
    const raw = await complete(nr, sys, `Headline: ${headline}`, 64, "hero-subject");
    // Strip the two things Flux reliably typesets — quotes and digit/percent runs — rather
    // than discarding the whole phrase, so we keep the per-article subject. (Brand names are
    // handled by the system prompt above.) Fall back to the generic subject only if too short.
    const cleaned = raw
      .replace(/["“”'`]/g, "")
      .replace(/\b\d[\d.,%]*/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return cleaned.length >= 8 ? cleaned : generic;
  } catch {
    return generic;
  }
}

function heroPrompt(subject: string, section: string): string {
  const motif = SECTION_STYLE[section] ?? "abstract editorial motif";
  return (
    `A wordless symbolic engraving evoking ${subject}. ${motif}. ` +
    "Vintage engraving and woodcut texture, muted ink black on cream paper, sage-green accent, " +
    "broadsheet front-page art, fine cross-hatching, high detail. " +
    "Wordless, no text, no letters, no numbers, no typography, no captions, no lettering."
  );
}

/** Generate the article's hero PNG and record its path. */
export async function makeHero(nr: Newsroom, articleId: string): Promise<void> {
  const article = await prisma.article.findUniqueOrThrow({ where: { id: articleId } });
  if (!nr.diffId) {
    nr.diffId = await loadModel({
      modelSrc: FLUX_2_KLEIN_4B_Q4_0,
      modelType: "diffusion",
      // Split-layout: LLM text-encoder + VAE are companions, not the modelSrc.
      modelConfig: { device: "gpu", threads: 4, llmModelSrc: QWEN3_4B_Q4_K_M, vaeModelSrc: FLUX_2_KLEIN_4B_VAE },
      onProgress: () => {},
    } as Parameters<typeof loadModel>[0]);
    nr.audit.record({ event: "model_load", modelSrc: "FLUX_2_KLEIN_4B_Q4_0", modelId: nr.diffId, extra: { role: "diffusion", engine: "flux2-klein" } });
  }

  const subject = await heroSubject(nr, article.headline, article.section);
  const prompt = heroPrompt(subject, article.section);
  const t = Date.now();
  // Flux flow-matching: `guidance` (3.5) + low `cfg_scale` (1). klein is distilled —
  // steps=4 is the sweet spot (~51 s @ 768×512, ~2× faster than SD's 22-step ~100 s,
  // and visibly better art). Each step costs ~12 s, so don't raise this casually.
  const { outputs } = diffusion({
    modelId: nr.diffId,
    prompt,
    width: 768,
    height: 512,
    steps: 4,
    guidance: 3.5,
    cfg_scale: 1,
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
