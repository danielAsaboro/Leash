/**
 * The skills ↔ chat bridge (server-only): a system-prompt section listing enabled
 * skills (name + description only — bodies stay on disk), `read_skill` to load a
 * skill's SKILL.md on demand, and `read_skill_file` for its attachments. Mirrors how
 * Claude-style skills keep the prompt small until a skill is actually relevant.
 */
import "server-only";
import { tool } from "ai";
import { z } from "zod";
import { listSkills, getSkill, readSkillFile } from "./skills-store.ts";
import type { LeashSource } from "./tools.ts";

/**
 * System-prompt section advertising enabled skills. EMPTY STRING when there are none —
 * an honest empty state, no boilerplate about a feature that has nothing in it.
 */
export async function skillsSystemSection(): Promise<string> {
  const enabled = (await listSkills()).filter((s) => s.enabled);
  if (enabled.length === 0) return "";
  const lines = enabled.map((s) => `- "${s.slug}": ${s.description || s.name}`);
  return (
    "You also have SKILLS — instruction documents the user wrote for you. When a request matches a skill's description, " +
    "call read_skill with its slug FIRST and follow those instructions. Available skills:\n" +
    lines.join("\n")
  );
}

export const skillTools = {
  read_skill: tool({
    description:
      "Read the full instructions of one of your skills (the user-authored instruction documents listed in your system prompt). Call this BEFORE acting whenever a request matches a skill's description, then follow the instructions.",
    inputSchema: z.object({
      skill: z.string().describe("The skill's slug, exactly as listed in the system prompt (e.g. 'trip-planning')."),
    }),
    execute: async ({ skill }) => {
      const s = await getSkill(skill.trim().toLowerCase());
      if (!s) {
        const known = (await listSkills()).filter((x) => x.enabled).map((x) => x.slug);
        return {
          text: `No skill named "${skill}".` + (known.length ? ` Available: ${known.join(", ")}.` : " No skills are defined yet."),
          sources: [] as LeashSource[],
        };
      }
      if (!s.enabled) return { text: `The skill "${s.slug}" is currently disabled.`, sources: [] as LeashSource[] };
      const attachments = s.files.length
        ? `\n\nThis skill has attached files: ${s.files.join(", ")} — load one with read_skill_file when the instructions reference it.`
        : "";
      return {
        // The closing line keeps small models from "calling" the skill as a tool next
        // step instead of just answering (observed on qwen3-4b).
        text: `Skill "${s.name}" instructions:\n\n${s.body || "(this skill has an empty body)"}${attachments}\n\nNow follow these instructions directly in your own answer — a skill is not a callable tool.`,
        sources: [{ kind: "graph", title: `Skill · ${s.name}`, snippet: s.description.slice(0, 200) }] as LeashSource[],
      };
    },
  }),

  read_skill_file: tool({
    description:
      "Read one of a skill's attached files (reference tables, templates, examples). Use AFTER read_skill, when its instructions point you to an attachment by name.",
    inputSchema: z.object({
      skill: z.string().describe("The skill's slug (e.g. 'trip-planning')."),
      file: z.string().describe("The attachment's filename exactly as listed by read_skill (e.g. 'airlines.md')."),
    }),
    execute: async ({ skill, file }) => {
      const r = await readSkillFile(skill.trim().toLowerCase(), file.trim());
      if (!r.ok) return { text: r.error, sources: [] as LeashSource[] };
      return {
        text: `Contents of ${skill}/${file}:\n\n${r.text}`,
        sources: [{ kind: "graph", title: `Skill file · ${skill}/${file}`, snippet: r.text.slice(0, 200) }] as LeashSource[],
      };
    },
  }),
};
