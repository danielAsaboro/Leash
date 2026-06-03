/**
 * The newsroom pipeline for ONE article: research → draft → review → image → publish.
 * Each step is bracketed by a `DaemonRun` row (Mission Control telemetry) and emits
 * audit records. Image generation is best-effort: a diffusion failure is recorded but
 * never blocks publication (the story still ships, just without a hero).
 */
import { recordRun } from "./context.ts";
import { research } from "./research.ts";
import { draft } from "./draft.ts";
import { review } from "./review.ts";
import { makeHero } from "./image.ts";
import { makeAudio } from "./audio.ts";
import { publish } from "./publish.ts";
import type { Newsroom } from "./context.ts";

export async function runPipeline(nr: Newsroom, articleId: string): Promise<void> {
  await recordRun("research", articleId, () => research(nr, articleId));
  await recordRun("draft", articleId, () => draft(nr, articleId));
  await recordRun("review", articleId, () => review(nr, articleId));
  try {
    await recordRun("image", articleId, () => makeHero(nr, articleId));
  } catch (err) {
    nr.audit.record({ event: "note", extra: { role: "image-failed", articleId, error: String(err).slice(0, 200) } });
  }
  // Read-aloud narration — best-effort, same contract as the hero image (never blocks publish).
  try {
    await recordRun("audio", articleId, () => makeAudio(nr, articleId));
  } catch (err) {
    nr.audit.record({ event: "note", extra: { role: "audio-failed", articleId, error: String(err).slice(0, 200) } });
  }
  await recordRun("publish", articleId, () => publish(articleId));
}
