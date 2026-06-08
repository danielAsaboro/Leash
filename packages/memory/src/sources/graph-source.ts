/**
 * Source: context-graph facts.
 *
 * The live graph lives in the Autobase corestore, which is single-process /
 * fd-locked (CLAUDE.md) — opening it from `evolve` while a serve/hub holds it would
 * deadlock. So this source reads the graph's underlying FILE signals instead:
 *   1. the markdown notes the senses connector ingests (`data/notes/*.md`), and
 *   2. an optional plain-JSONL GraphStore export (`data/graph.jsonl`), if present.
 * Both are real, on-disk, corestore-free. Each fact becomes Q→A pairs.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { GraphStore } from "@mycelium/senses";
import type { TrainingPair } from "../types.ts";
import { GRAPH_JSONL, NOTES_DIR } from "../paths.ts";
import { paraphraseFact, splitFactLines } from "../text.ts";

function readNotesFacts(dir: string): TrainingPair[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const pairs: TrainingPair[] = [];
  for (const name of readdirSync(dir).filter((n) => /\.(md|txt|markdown)$/i.test(n))) {
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf-8");
    } catch {
      continue;
    }
    for (const fact of splitFactLines(text)) {
      pairs.push(...paraphraseFact(fact, "graph", `notes/${name}`));
    }
  }
  return pairs;
}

function readGraphStoreFacts(file: string): TrainingPair[] {
  if (!existsSync(file)) return [];
  const pairs: TrainingPair[] = [];
  for (const node of new GraphStore(file).all()) {
    if (typeof node.text !== "string" || !node.text.trim()) continue;
    for (const fact of splitFactLines(node.text)) {
      pairs.push(...paraphraseFact(fact, "graph", node.source ?? node.id));
    }
  }
  return pairs;
}

export function readGraphPairs(notesDir: string = NOTES_DIR, graphJsonl: string = GRAPH_JSONL): TrainingPair[] {
  return [...readNotesFacts(notesDir), ...readGraphStoreFacts(graphJsonl)];
}
