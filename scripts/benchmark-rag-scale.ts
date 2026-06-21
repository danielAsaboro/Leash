/**
 * Real QVAC scaled-corpus RAG benchmark.
 *
 * Builds a deterministic private-operations corpus, embeds and indexes every
 * document through @qvac/sdk, then measures retrieval and citation accuracy.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { homedir, totalmem } from "node:os";
import { join } from "node:path";
import {
  loadModel,
  ragCloseWorkspace,
  ragIngest,
  ragReindex,
  ragSearch,
  unloadModel,
} from "@qvac/sdk";
import { GTE_LARGE_FP16 } from "@mycelium/senses";

const documentCount = Math.max(100, Number(process.env["LEASH_RAG_DOCUMENTS"] ?? 1_000));
const queryCount = Math.max(10, Math.min(documentCount, Number(process.env["LEASH_RAG_QUERIES"] ?? 100)));
const topK = 5;
const minimumAccuracy = Number(process.env["LEASH_RAG_MIN_ACCURACY"] ?? 0.9);
const workspace = `leash-scale-${Date.now().toString(36)}`;

const adjectives = [
  "amber", "arctic", "azure", "brisk", "bronze", "cedar", "cobalt", "coral",
  "crimson", "dawn", "ember", "fern", "frost", "golden", "indigo", "ivory",
  "jade", "lunar", "maple", "misty", "navy", "opal", "pearl", "pine",
  "quartz", "rapid", "ruby", "silver", "solar", "teal", "umber", "violet",
];
const nouns = [
  "albatross", "badger", "cedar", "dolphin", "egret", "falcon", "gazelle", "heron",
  "ibis", "jaguar", "kingfisher", "lynx", "marten", "narwhal", "otter", "puffin",
  "quail", "raven", "salmon", "tern", "urchin", "viper", "walrus", "yak",
  "acorn", "birch", "canyon", "delta", "estuary", "fjord", "grove", "harbor",
];
const regions = ["Lagos", "Accra", "Nairobi", "Cape Town", "Dakar", "Kigali", "Cairo", "Tunis"];
const owners = ["Ada", "Bola", "Chidi", "Dayo", "Eno", "Femi", "Gina", "Hauwa"];

interface Fixture {
  sourceId: string;
  codename: string;
  region: string;
  owner: string;
  text: string;
}

function fixtures(count: number): Fixture[] {
  return Array.from({ length: count }, (_, index) => {
    const sourceId = `readiness-doc-${String(index + 1).padStart(4, "0")}`;
    const codename = `${adjectives[Math.floor(index / nouns.length) % adjectives.length]}-${nouns[index % nouns.length]}`;
    const region = regions[(index * 5 + 3) % regions.length]!;
    const owner = owners[(index * 7 + 1) % owners.length]!;
    const rack = `R${String((index * 13) % 97).padStart(2, "0")}`;
    return {
      sourceId,
      codename,
      region,
      owner,
      text: `[Source ${sourceId}] Private operations dossier. Project codename ${codename} is assigned to the ${region} deployment region. ${owner} is the accountable owner. Its primary retail-device rack is ${rack}. Escalations for ${codename} must quote source ${sourceId}. This record is authoritative and supersedes informal notes.`,
    };
  });
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.floor((sorted.length - 1) * fraction)] ?? 0;
}

async function directorySize(path: string): Promise<number> {
  let total = 0;
  try {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) total += await directorySize(child);
      else if (entry.isFile()) total += (await stat(child)).size;
    }
  } catch {
    return total;
  }
  return total;
}

const corpus = fixtures(documentCount);
const corpusHash = createHash("sha256").update(corpus.map((item) => item.text).join("\n")).digest("hex");
const ragRoot = join(homedir(), ".qvac", "rag-hyperdb", workspace);
let embeddingModelId: string | undefined;

try {
  const loadStarted = Date.now();
  embeddingModelId = await loadModel({ modelSrc: GTE_LARGE_FP16, modelType: "embeddings", onProgress: () => {} });
  const modelLoadMs = Date.now() - loadStarted;

  const ingestStarted = Date.now();
  const ingest = await ragIngest({
    modelId: embeddingModelId,
    workspace,
    documents: corpus.map((item) => item.text),
    chunk: false,
    progressInterval: 1_000,
    onProgress: (stage, current, total) => process.stderr.write(`\r${stage} ${current}/${total}`),
  });
  process.stderr.write("\n");
  const ingestMs = Date.now() - ingestStarted;

  const reindexStarted = Date.now();
  const reindex = await ragReindex({ workspace });
  const reindexMs = Date.now() - reindexStarted;
  const indexBytes = await directorySize(ragRoot);

  const stride = Math.max(1, Math.floor(documentCount / queryCount));
  const selected = Array.from({ length: queryCount }, (_, queryIndex) => corpus[Math.min(documentCount - 1, queryIndex * stride)]!);
  const latencies: number[] = [];
  let recalled = 0;
  let cited = 0;
  const misses: Array<{ sourceId: string; codename: string; hits: string[] }> = [];

  for (const [index, expected] of selected.entries()) {
    const started = Date.now();
    const hits = await ragSearch({
      modelId: embeddingModelId,
      workspace,
      query: `For project ${expected.codename}, which deployment region is authoritative and which source proves it?`,
      topK,
    });
    latencies.push(Date.now() - started);
    const expectedSource = `Source ${expected.sourceId}`;
    const recallHit = hits.some((hit) => hit.content.includes(expectedSource));
    const citationHit = hits[0]?.content.includes(expectedSource) === true && hits[0].content.includes(expected.region);
    if (recallHit) recalled++;
    if (citationHit) cited++;
    if (!recallHit || !citationHit) {
      misses.push({ sourceId: expected.sourceId, codename: expected.codename, hits: hits.map((hit) => hit.content.slice(0, 180)) });
    }
    process.stderr.write(`\rqueries ${index + 1}/${selected.length}`);
  }
  process.stderr.write("\n");

  latencies.sort((a, b) => a - b);
  const recallAt5 = recalled / selected.length;
  const citationAccuracy = cited / selected.length;
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    qvacOnly: true,
    hardware: { totalMemoryBytes: totalmem() },
    corpus: { documents: documentCount, corpusHash, bytes: Buffer.byteLength(corpus.map((item) => item.text).join("\n")) },
    ingest: {
      modelLoadMs,
      ingestMs,
      documentsPerSecond: documentCount / (ingestMs / 1_000),
      processed: ingest.processed.length,
      dropped: ingest.droppedIndices.length,
      reindexed: reindex.reindexed,
      reindexMs,
      indexBytes,
      driverPeakRssBytes: process.resourceUsage().maxRSS * 1_024,
    },
    retrieval: {
      queries: selected.length,
      topK,
      recallAt5,
      citationAccuracy,
      latencyMs: {
        min: latencies[0] ?? 0,
        p50: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
        max: latencies.at(-1) ?? 0,
      },
      misses,
    },
  };

  const logsDir = join(process.cwd(), "logs");
  await mkdir(logsDir, { recursive: true });
  const reportPath = join(logsDir, `rag-scale-${Date.now().toString(36)}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));

  assert.equal(ingest.droppedIndices.length, 0, "QVAC dropped documents during ingest");
  assert.ok(recallAt5 >= minimumAccuracy, `recall@5 ${recallAt5.toFixed(3)} is below ${minimumAccuracy.toFixed(3)}`);
  assert.ok(citationAccuracy >= minimumAccuracy, `citation accuracy ${citationAccuracy.toFixed(3)} is below ${minimumAccuracy.toFixed(3)}`);
  console.log("benchmark:rag-scale PASS");
} finally {
  try {
    await ragCloseWorkspace({ workspace, deleteOnClose: true });
  } catch {}
  if (embeddingModelId) await unloadModel({ modelId: embeddingModelId });
}
