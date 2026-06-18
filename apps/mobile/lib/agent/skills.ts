/**
 * On-device skills: local store + selection + system-prompt injection.
 *
 * Skills are authored on the desktop (`.claude/skills`). On the phone they live in a single local
 * JSON file, populated by `setSkills()` — the intended caller is a mesh sync that pulls the skills
 * list + bodies from a connected desktop peer (over the mesh CRDT / a one-time fetch on join). Until
 * that sync runs the store is simply empty and `activeSkillForTurn` returns null (no skill injected),
 * so nothing breaks. Selection itself (lexical + on-device embeddings + RRF) is fully ported and real
 * — see `skill-selection.ts`.
 *
 * NOTE: the mesh transport that fills this store (desktop → phone skill replication) is the one
 * remaining Stage-4 piece; the selection / injection / "Loaded skill" UI are complete and run the
 * moment skills are present.
 */
import * as FileSystem from "expo-file-system/legacy";
import { embed } from "@qvac/sdk";
import { selectSkill, type SkillDef, type SkillMatch } from "./skill-selection";
import { listMeshSkills } from "../../meshClient";
import type { SkillEvent } from "../../ai-elements/SkillEventCard";

const FILE = `${FileSystem.documentDirectory}skills.json`;

/** Embedding model id used for semantic skill matching; null → lexical-only selection. */
let embeddingModelId: string | null = null;

/** Set (or clear) the on-device embedding model used to rank skills. Call when an embedder loads. */
export function setSkillEmbeddingModel(id: string | null): void {
  embeddingModelId = id;
}

export async function getSkills(): Promise<SkillDef[]> {
  try {
    return JSON.parse(await FileSystem.readAsStringAsync(FILE)) as SkillDef[];
  } catch {
    return [];
  }
}

/** Replace the local skill set. Intended caller: the desktop→phone mesh skills sync. */
export async function setSkills(skills: SkillDef[]): Promise<void> {
  await FileSystem.writeAsStringAsync(FILE, JSON.stringify(skills));
}

/**
 * Pull the skills the desktop has published into the mesh CRDT and cache them locally. Best-effort:
 * a no-op (returns 0) when not joined or none published, leaving any existing cache intact. Call on
 * mesh join and on app foreground so the phone's skill set tracks the desktop's.
 */
export async function syncSkillsFromMesh(): Promise<number> {
  try {
    const mesh = await listMeshSkills();
    if (mesh.length === 0) return 0;
    await setSkills(
      mesh.map((m) => ({ slug: m.slug, name: m.name, description: m.description, body: m.body, examples: m.examples, whenToUse: m.whenToUse })),
    );
    return mesh.length;
  } catch {
    return 0;
  }
}

/** Embed via the on-device SDK, when an embedding model is configured (else undefined → lexical-only). */
function embedder(): ((texts: string[]) => Promise<number[][]>) | undefined {
  const id = embeddingModelId;
  if (!id) return undefined;
  return async (texts: string[]) => {
    const { embedding } = await embed({ modelId: id, text: texts });
    return embedding as number[][];
  };
}

export type ActiveSkill = { systemAddon: string; event: SkillEvent };

/**
 * Pick the active skill for a turn and produce (a) the system-prompt addon carrying the skill body,
 * and (b) a `SkillEvent` for the "Loaded skill ·" card. Returns null when no skill clears the gate.
 */
export async function activeSkillForTurn(userText: string): Promise<ActiveSkill | null> {
  const skills = await getSkills();
  if (skills.length === 0) return null;
  const match: SkillMatch | null = await selectSkill(userText, skills, embedder());
  if (!match) return null;
  const { skill, mode } = match;
  const systemAddon = `\n\nActive skill — ${skill.name}:\n${skill.body}`;
  return { systemAddon, event: { skills: [{ name: skill.name, slug: skill.slug }], mode } };
}
