/**
 * The skills ↔ chat bridge (server-only): a system-prompt section listing enabled
 * skills (name + description only — bodies stay on disk), `read_skill` to load a
 * skill's SKILL.md on demand, `read_skill_file` for its attachments, and
 * `run_skill_script` for its bundled `scripts/*` (real execution — approval-gated by
 * default, see skill-exec.ts). Mirrors how Claude-style skills keep the prompt small
 * until a skill is actually relevant.
 */
import "server-only";
import { tool } from "ai";
import { z } from "zod";
import { listSkills, getSkill, readSkillFile } from "./skills-store.ts";
import { runSkillScript } from "./skill-exec.ts";
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
      const scripts = s.files.filter((f) => f.startsWith("scripts/"));
      const docs = s.files.filter((f) => !f.startsWith("scripts/"));
      const attachments =
        (docs.length ? `\n\nThis skill has attached files: ${docs.join(", ")} — load one with read_skill_file when the instructions reference it.` : "") +
        (scripts.length ? `\n\nThis skill has executable scripts: ${scripts.join(", ")} — run one with run_skill_script when the instructions say to.` : "");
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

  run_skill_script: tool({
    description:
      "Run one of a skill's bundled scripts (the executable files under its scripts/ folder, listed by read_skill). Use AFTER read_skill, when its instructions say to run a script. The script executes on this machine and its output comes back to you.",
    inputSchema: z.object({
      skill: z.string().describe("The skill's slug (e.g. 'trip-planning')."),
      script: z.string().describe("The script path exactly as listed by read_skill (e.g. 'scripts/fetch.sh')."),
      args: z.array(z.string()).optional().describe("Command-line arguments for the script, if its instructions call for any."),
    }),
    execute: async ({ skill, script, args }) => {
      const r = await runSkillScript(skill.trim().toLowerCase(), script.trim(), args ?? []);
      if (r.error && r.exitCode === null) return { text: r.error, sources: [] as LeashSource[] };
      const parts = [
        `Script ${skill}/${script} exited with code ${r.exitCode ?? "?"}${r.error ? ` (${r.error})` : ""}.`,
        r.stdout.trim() ? `stdout:\n\`\`\`\n${r.stdout.trim()}\n\`\`\`` : "stdout: (empty)",
        r.stderr.trim() ? `stderr:\n\`\`\`\n${r.stderr.trim()}\n\`\`\`` : "",
      ].filter(Boolean);
      return {
        text: parts.join("\n\n"),
        sources: [{ kind: "graph", title: `Skill script · ${skill}/${script}`, snippet: r.stdout.slice(0, 200) }] as LeashSource[],
      };
    },
  }),
};
