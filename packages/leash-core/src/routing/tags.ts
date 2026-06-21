/**
 * Capability tags per served alias. PRIVATE MESH: every device is owned, so we resolve
 * tags locally from this table by the advertised alias string. PUBLIC MESH (extension
 * seam): a peer advertises its own tags for models we don't know — `advertised` wins then.
 * An alias with neither resolves to a general text last-resort (used only if nothing else
 * clears the bar).
 */
import type { CapabilityTags } from "./types.ts";

const ALIAS_TAGS: Record<string, CapabilityTags> = {
  chat: { modality: "text", paramClass: "small", specialist: "general" },
  "chat-compact": { modality: "text", paramClass: "tiny", specialist: "general" },
  "chat-large": { modality: "text", paramClass: "small", specialist: "general" },
  vision: { modality: "vision", paramClass: "mid", specialist: "vision" },
  ocr: { modality: "ocr", paramClass: "tiny", specialist: "ocr" },
  health: { modality: "text", paramClass: "small", specialist: "health" },
  embed: { modality: "text", paramClass: "tiny", specialist: "general" },
  stt: { modality: "stt", paramClass: "small", specialist: "general" },
  tts: { modality: "tts", paramClass: "small", specialist: "general" },
};

const FALLBACK: CapabilityTags = { modality: "text", paramClass: "unknown", specialist: "general" };

/** Resolve an alias to capability tags. Advertised tags (public-mesh seam) win over the
 *  local table for aliases we don't know; known aliases use the table. */
export function tagsForAlias(alias: string, advertised?: Partial<CapabilityTags>): CapabilityTags {
  const known = ALIAS_TAGS[alias.toLowerCase()];
  if (known) return known;
  if (advertised && (advertised.modality || advertised.paramClass || advertised.specialist)) {
    return { ...FALLBACK, ...advertised };
  }
  return FALLBACK;
}
