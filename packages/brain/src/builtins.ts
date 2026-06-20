export const BRAIN_BUILTIN_AGENT_SLUGS = ["coder", "health", "leash", "researcher", "summarizer"] as const;

export const BRAIN_BUILTIN_SKILL_SLUGS = [
  "computer-use",
  "context-grounding",
  "daily-paper",
  "deep-research",
  "file-finder",
  "health-safety",
  "image-generator",
  "mcp-installer",
  "memory-keeper",
  "photo-finder",
  "smart-home",
  "task-manager",
] as const;

export type BrainBuiltinAgentSlug = (typeof BRAIN_BUILTIN_AGENT_SLUGS)[number];
export type BrainBuiltinSkillSlug = (typeof BRAIN_BUILTIN_SKILL_SLUGS)[number];
