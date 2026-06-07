/**
 * Computer-use model availability (server-only) — resolves which alias drives the
 * computer tools and where it can run right now (local serve / warm paired peer /
 * nowhere), for the Tools tab's info note. Degrades honestly: serve down and hypha
 * down are each named, never silently hidden.
 */
import "server-only";
import { COMPUTER_MODEL, CHAT_MODEL, QVAC_OPENAI_URL } from "./provider.ts";
import { liveModels } from "./models.ts";
import { meshStatus } from "./hypha.ts";

const BROKER_PORT = Number(process.env["LEASH_BROKER_PORT"] ?? 11436);

/** One human line: "Drives with <alias> …" — local vs delegated vs unavailable. */
export async function computerModelInfo(): Promise<string> {
  const [local, mesh] = await Promise.all([liveModels(), meshStatus()]);
  const localHas = local.up && local.ready.includes(COMPUTER_MODEL);
  const warmPeer = mesh.peers.find((p) => p.live && p.warmModels.includes(COMPUTER_MODEL));
  const viaBroker = QVAC_OPENAI_URL.includes(`:${BROKER_PORT}`);
  const head = `Drives with ${COMPUTER_MODEL}`;

  if (COMPUTER_MODEL === CHAT_MODEL) {
    const where = localHas ? "local" : local.up ? "local — not in serve.models right now" : "local — serve is down";
    return `${head} (${where}) · set LEASH_COMPUTER_MODEL to a bigger served alias (e.g. gpt-oss-20b), local or warm on a paired peer, for stronger GUI control`;
  }
  if (localHas) return warmPeer ? `${head} (local; also warm on peer “${warmPeer.displayName}”)` : `${head} (local)`;
  if (warmPeer) {
    return viaBroker
      ? `${head} · delegated to peer “${warmPeer.displayName}” (warm, via the broker)`
      : `${head} · ⚠ warm on peer “${warmPeer.displayName}” but QVAC_OPENAI_URL bypasses the broker — point it at :${BROKER_PORT} to delegate`;
  }
  const meshNote = mesh.error ? " (mesh status unavailable — Hypha daemon down)" : "";
  return `${head} · ⚠ not served locally or warm on a peer${meshNote} — serve it or pair a device that does`;
}
