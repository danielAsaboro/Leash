/**
 * The personal brief (offline step): draw a daily BRIEF from the user's PRIVATE
 * device-mesh graph — the notes / voice memos / photos the rest of the world never
 * sees. This is what makes The Understory a *private* paper: a section written only
 * from what's beneath the surface of your own day.
 *
 * We build the personal graph from data/ via the proven senses connectors (notes
 * always; voice + photo best-effort, loading whisper/OCR only when those dirs exist),
 * then stage ONE BRIEF article per day with its graph nodes as the research pack.
 */
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { GraphStore, seedFromDataDir, loadWhisper, unloadWhisper, loadOcr, unloadOcr } from "@mycelium/senses";
import type { GraphNode } from "@mycelium/shared";
import { prisma, Stage, Origin, Section } from "@mycelium/db";
import { NOTES_DIR, VOICE_DIR, PHOTOS_DIR, PERSONAL_GRAPH_FILE, today } from "./config.ts";
import type { Newsroom } from "./context.ts";
import type { ResearchPack, PackSource } from "./pack.ts";
import { tidy } from "./util.ts";

function labelFor(n: GraphNode): string {
  const base = basename(n.source);
  if (n.kind === "voice") return `Voice memo — ${base}`;
  if (n.kind === "photo") return `Photo — ${base}`;
  return `Note — ${base}`;
}

/** Refresh the newsroom's local copy of the personal graph from data/. Returns all nodes. */
export async function buildPersonalGraph(nr: Newsroom): Promise<GraphNode[]> {
  const graph = new GraphStore(PERSONAL_GRAPH_FILE);
  const hasVoice = existsSync(VOICE_DIR);
  const hasPhoto = existsSync(PHOTOS_DIR);
  const sttId = hasVoice ? await loadWhisper(nr.audit) : undefined;
  const ocrId = hasPhoto ? await loadOcr(nr.audit) : undefined;
  try {
    await seedFromDataDir({
      graph,
      notesDir: NOTES_DIR,
      voiceDir: hasVoice ? VOICE_DIR : undefined,
      sttModelId: sttId,
      photoDir: hasPhoto ? PHOTOS_DIR : undefined,
      ocrModelId: ocrId,
      audit: nr.audit,
    });
  } finally {
    if (sttId) await unloadWhisper(sttId, nr.audit);
    if (ocrId) await unloadOcr(ocrId, nr.audit);
  }
  return graph.all();
}

/**
 * Stage today's personal brief if one isn't already queued/published for the date.
 * Returns the new article id, or null if there's nothing new / a brief already exists.
 */
export async function proposePersonalBrief(nr: Newsroom): Promise<string | null> {
  const date = today();
  const existing = await prisma.article.findFirst({ where: { date, origin: Origin.PERSONAL } });
  if (existing) return null;

  const nodes = await buildPersonalGraph(nr);
  if (nodes.length === 0) return null;

  const sources: PackSource[] = nodes.map((n) => ({ label: labelFor(n), kind: n.kind, text: tidy(n.text, 1200) }));
  const pack: ResearchPack = { topic: `Your private brief for ${date}`, sources };

  const headline = `Beneath the surface — your brief for ${date}`;
  const article = await prisma.article.create({
    data: {
      slug: `brief-${date}`,
      date,
      section: Section.BRIEF,
      origin: Origin.PERSONAL,
      headline,
      dek: "What your private mesh noticed today.",
      stage: Stage.QUEUED,
      sources: { create: sources.map((s, i) => ({ label: s.label, kind: s.kind, order: i })) },
      dossier: { create: { research: JSON.stringify(pack), graphNodeIds: JSON.stringify(nodes.map((n) => n.id)) } },
    },
  });
  return article.id;
}
