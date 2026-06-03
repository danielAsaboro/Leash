/**
 * The newsroom's beat: which RSS/Atom feeds we poll, and the section each maps to.
 *
 * Feeds are the ONLY network dependency of the daemon (the "online" discovery step);
 * everything after — research grounding, drafting, review, image-gen — runs on-device.
 * Hacker News' hnrss.org endpoints are stable, query-scoped RSS 2.0, so each feed
 * already arrives on-topic for its section.
 */
import type { Section } from "@mycelium/db";

export interface Feed {
  /** Short human label, used as the discovered Source's label. */
  name: string;
  url: string;
  section: Section;
}

export const FEEDS: Feed[] = [
  { name: "HN · AI & models", url: "https://hnrss.org/newest?q=AI+model&points=20", section: "AI" },
  { name: "HN · LLMs", url: "https://hnrss.org/newest?q=LLM&points=20", section: "AI" },
  { name: "HN · GPUs & inference", url: "https://hnrss.org/newest?q=GPU+inference&points=10", section: "COMPUTE" },
  { name: "HN · edge compute", url: "https://hnrss.org/newest?q=edge+compute&points=5", section: "COMPUTE" },
  { name: "HN · Solana", url: "https://hnrss.org/newest?q=Solana&points=5", section: "SOLANA" },
];

/** Optional keyword nudge if a feed item clearly belongs to a different section. */
export function refineSection(fallback: Section, title: string): Section {
  const t = title.toLowerCase();
  if (/\bsolana\b/.test(t)) return "SOLANA";
  if (/\b(gpu|cuda|inference|tpu|fpga|datacenter|silicon|chip)\b/.test(t)) return "COMPUTE";
  if (/\b(llm|model|ai|agent|transformer|diffusion|neural)\b/.test(t)) return "AI";
  return fallback;
}
