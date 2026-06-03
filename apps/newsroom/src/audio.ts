/**
 * Read-aloud audio: the article narrated on-device via `@qvac/sdk` `textToSpeech()`
 * (GGML Supertonic) — no cloud, works offline once the model is warm. The TTS model is
 * loaded lazily on first use and reused across the run. Best-effort, exactly like the
 * hero image: a synthesis failure is recorded but never blocks publication.
 *
 * The WAV lands in the web app's public/ (served at /audio/<id>.wav), so the reader's
 * "🔊 Read aloud" control is a plain <audio> tag and `apps/web` stays SDK-free — the
 * same daemon-side-render / static-serve precedent as hero images.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@mycelium/db";
import { loadTts, synthesizeToWav } from "@mycelium/senses";
import { AUDIO_DIR } from "./config.ts";
import type { Newsroom } from "./context.ts";

/** Strip Markdown to clean prose for narration (drops [Source N] tags, links, syntax). */
function toPlainText(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, " ") // fenced code blocks
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
    .replace(/\[Source\s+\d+\]/gi, " ") // citation tags — don't read "[Source 2]" aloud
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → link text
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/^\s{0,3}#{1,6}\s+/gm, "") // ATX headings
    .replace(/^\s{0,3}>\s?/gm, "") // blockquotes
    .replace(/^\s{0,3}[-*+]\s+/gm, "") // unordered list markers
    .replace(/^\s{0,3}\d+\.\s+/gm, "") // ordered list markers
    .replace(/(\*\*|__|\*|_|~~)/g, "") // emphasis markers
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, ". ") // paragraph breaks → sentence pause
    .replace(/\n/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Build the full narration: headline, dek, then the article prose. */
function narration(headline: string, dek: string, body: string): string {
  const lead = [headline.trim().replace(/\.?$/, "."), dek.trim().replace(/\.?$/, dek ? "." : "")].filter(Boolean).join(" ");
  const prose = toPlainText(body);
  return [lead, prose].filter(Boolean).join(" ");
}

/** Synthesize the article's read-aloud WAV and record its path. */
export async function makeAudio(nr: Newsroom, articleId: string): Promise<void> {
  const article = await prisma.article.findUniqueOrThrow({ where: { id: articleId } });
  if (!nr.ttsId) nr.ttsId = await loadTts(nr.audit);

  const text = narration(article.headline, article.dek, article.body);
  mkdirSync(AUDIO_DIR, { recursive: true });
  const file = join(AUDIO_DIR, `${articleId}.wav`);
  await synthesizeToWav({ ttsModelId: nr.ttsId, text, outPath: file, audit: nr.audit });

  await prisma.article.update({ where: { id: articleId }, data: { audioPath: `/audio/${articleId}.wav` } });
}
