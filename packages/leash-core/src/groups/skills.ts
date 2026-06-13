/**
 * Skills tool group — load a skill's instructions/attachments on demand and run its bundled
 * scripts. (Skill ROUTING — auto-activation + the system-prompt catalog — stays in the web
 * route; these are the model-callable tools.) `run_skill_script` is real execution and stays
 * approval-gated by name in the web's tool-config.
 */
import { z } from "zod";
import { listSkills, getSkill, readSkillFile } from "../skills-store.ts";
import { runSkillScript } from "../skill-exec.ts";
import type { LeashSource } from "../sources.ts";
import { defineTool, type ToolGroup } from "./types.ts";

export const skillsGroup: ToolGroup = {
  id: "skills",
  label: "Skills",
  description: "Load the user's skills (instruction documents) on demand and run their bundled scripts: read_skill, read_skill_file, run_skill_script.",
  tools: [
    defineTool({
      name: "read_skill",
      description:
        "Read the full instructions of one of your skills (the user-authored instruction documents listed in your system prompt). Call this BEFORE acting whenever a request matches a skill's description, then follow the instructions.",
      inputSchema: {
        skill: z.string().describe("The skill's slug, exactly as listed in the system prompt (e.g. 'trip-planning')."),
      },
      handler: async ({ skill }) => {
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
          text: `Skill "${s.name}" instructions:\n\n${s.body || "(this skill has an empty body)"}${attachments}\n\nNow follow these instructions directly in your own answer — a skill is not a callable tool.`,
          sources: [{ kind: "graph", title: `Skill · ${s.name}`, snippet: s.description.slice(0, 200) }] as LeashSource[],
        };
      },
    }),

    defineTool({
      name: "read_skill_file",
      description:
        "Read one of a skill's attached files (reference tables, templates, examples). Use AFTER read_skill, when its instructions point you to an attachment by name.",
      inputSchema: {
        skill: z.string().describe("The skill's slug (e.g. 'trip-planning')."),
        file: z.string().describe("The attachment's filename exactly as listed by read_skill (e.g. 'airlines.md')."),
      },
      handler: async ({ skill, file }) => {
        const r = await readSkillFile(skill.trim().toLowerCase(), file.trim());
        if (!r.ok) return { text: r.error, sources: [] as LeashSource[] };
        return {
          text: `Contents of ${skill}/${file}:\n\n${r.text}`,
          sources: [{ kind: "graph", title: `Skill file · ${skill}/${file}`, snippet: r.text.slice(0, 200) }] as LeashSource[],
        };
      },
    }),

    defineTool({
      name: "run_skill_script",
      needsApproval: true,
      description:
        "Run one of a skill's bundled scripts (the executable files under its scripts/ folder, listed by read_skill). Use AFTER read_skill, when its instructions say to run a script. The script executes on this machine and its output comes back to you.",
      inputSchema: {
        skill: z.string().describe("The skill's slug (e.g. 'trip-planning')."),
        script: z.string().describe("The script path exactly as listed by read_skill (e.g. 'scripts/fetch.sh')."),
        args: z.array(z.string()).optional().describe("Command-line arguments for the script, if its instructions call for any."),
      },
      handler: async ({ skill, script, args }) => {
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
  ],
};
