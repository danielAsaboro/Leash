import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_RAG_CHUNK_POLICY,
  loadRagManifest,
  searchRagWorkspace,
  syncRagWorkspace,
  type RagWorkspaceOps,
  type RagSourceDoc,
} from "../src/rag-workspace.ts";

const dir = mkdtempSync(join(tmpdir(), "mycelium-rag-test-"));
const manifestPath = join(dir, "manifest.json");

const chunksByContent = new Map<string, string[]>([
  ["alpha memo about qvac local retrieval", ["alpha memo about qvac local retrieval"]],
  ["bravo memo about deleted content", ["bravo memo about deleted content"]],
  ["alpha memo changed with mesh routing", ["alpha memo changed", "mesh routing"]],
]);

const deletedIds: string[] = [];
const savedIds: string[] = [];
let reindexed = 0;

const ops: RagWorkspaceOps = {
  async ragChunk({ documents, chunkOpts }) {
    assert.deepEqual(chunkOpts, DEFAULT_RAG_CHUNK_POLICY);
    const docs = Array.isArray(documents) ? documents : [documents];
    return docs.flatMap((doc) => (chunksByContent.get(doc) ?? [doc]).map((content, i) => ({ id: `sdk-${i}`, content })));
  },
  async embed({ text }) {
    const texts = Array.isArray(text) ? text : [text];
    return { embedding: texts.map((value) => [value.length, value.charCodeAt(0) ?? 0]) };
  },
  async ragSaveEmbeddings({ documents }) {
    savedIds.push(...documents.map((d) => d.id));
    return documents.map((d) => ({ id: d.id }));
  },
  async ragDeleteEmbeddings({ ids }) {
    deletedIds.push(...ids);
  },
  async ragSearch() {
    return [
      { id: savedIds.findLast((id) => id.includes("note-a")) ?? "missing", content: "alpha memo changed", score: 0.91 },
      { id: "unknown-id", content: "orphan", score: 0.2 },
    ];
  },
  async ragReindex() {
    reindexed++;
    return { reindexed: true };
  },
  async ragListWorkspaces() {
    return [{ name: "unit-workspace", open: true }];
  },
  async ragCloseWorkspace() {},
  async ragDeleteWorkspace() {},
};

const initialDocs: RagSourceDoc[] = [
  {
    sourceId: "note-a",
    source: "Alpha Note",
    kind: "note",
    content: "alpha memo about qvac local retrieval",
    updatedAt: "2026-06-20T10:00:00.000Z",
  },
  {
    sourceId: "note-b",
    source: "Bravo Note",
    kind: "note",
    content: "bravo memo about deleted content",
    updatedAt: "2026-06-20T10:00:00.000Z",
  },
];

const first = await syncRagWorkspace({
  embModelId: "emb-test",
  workspace: "unit-workspace",
  manifestPath,
  docs: initialDocs,
  ops,
  reindexThreshold: 99,
});

assert.equal(first.added, 2);
assert.equal(first.changed, 0);
assert.equal(first.deleted, 0);
assert.equal(first.unchanged, 0);
assert.equal(first.chunksSaved, 2);

const second = await syncRagWorkspace({
  embModelId: "emb-test",
  workspace: "unit-workspace",
  manifestPath,
  docs: [
    {
      ...initialDocs[0],
      content: "alpha memo changed with mesh routing",
      updatedAt: "2026-06-20T11:00:00.000Z",
    },
  ],
  ops,
  reindexThreshold: 1,
});

assert.equal(second.added, 0);
assert.equal(second.changed, 1);
assert.equal(second.deleted, 1);
assert.equal(second.unchanged, 0);
assert.equal(second.chunksSaved, 2);
assert.equal(reindexed, 1);
assert.ok(deletedIds.some((id) => id.includes("note-a")), "changed doc stale chunks are deleted");
assert.ok(deletedIds.some((id) => id.includes("note-b")), "removed doc chunks are deleted");

const manifest = loadRagManifest(manifestPath);
assert.equal(Object.keys(manifest.sources).length, 1);
assert.equal(manifest.sources["note-a"]?.chunks.length, 2);
assert.match(readFileSync(manifestPath, "utf-8"), /"sourceId": "note-a"/);

const hits = await searchRagWorkspace({
  embModelId: "emb-test",
  workspace: "unit-workspace",
  manifestPath,
  query: "mesh routing",
  topK: 8,
  ops,
});

assert.equal(hits.length, 2);
assert.equal(hits[0]?.sourceId, "note-a");
assert.equal(hits[0]?.source, "Alpha Note");
assert.equal(hits[0]?.kind, "note");
assert.equal(hits[0]?.score, 0.91);
assert.equal(hits[1]?.sourceId, undefined);

console.log("rag-workspace.test passed");
