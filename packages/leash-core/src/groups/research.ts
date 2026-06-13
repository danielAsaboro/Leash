/**
 * Research tool group — `deep_research(question)` kicks off a detached web-research run and
 * returns its id + the /research link. It does NOT block the turn on the (multi-minute) run.
 * Needs network (it searches the live web), so it fails honestly when offline.
 */
import { z } from "zod";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { generateId } from "ai";
import { REPO_ROOT } from "../paths.ts";
import type { LeashSource } from "../sources.ts";
import { defineTool, type ToolGroup } from "./types.ts";

const SCRIPT = join(REPO_ROOT, "apps", "web", "scripts", "leash-research.mts");
const NO_SOURCES: LeashSource[] = [];

export const researchGroup: ToolGroup = {
  id: "research",
  label: "Research",
  description: "Run a deep, multi-source WEB research run (searches the live web, reads sources, synthesizes a cited report) in the background. Needs network.",
  tools: [
    defineTool({
      name: "deep_research",
      description:
        "Start a DEEP RESEARCH run on a question: the system searches the live web, reads multiple sources, and synthesizes a cited report over several minutes. Use for questions that need current, multi-source web evidence (comparisons, 'what's the latest on…', surveys). It runs in the BACKGROUND — you get a link, not an immediate answer. (Needs network.)",
      inputSchema: {
        question: z.string().describe("The research question to investigate."),
      },
      handler: async ({ question }) => {
        const q = question.trim();
        if (!q) return { text: "Provide a research question.", sources: NO_SOURCES };
        const id = generateId();
        try {
          const child = spawn("npx", ["tsx", SCRIPT, id, q.slice(0, 500)], { cwd: REPO_ROOT, detached: true, stdio: "ignore" });
          child.unref();
        } catch (err) {
          return { text: `Couldn't start research: ${err instanceof Error ? err.message : err}`, sources: NO_SOURCES };
        }
        return {
          text: `Started a deep-research run on "${q}". It runs in the background (a few minutes) — follow progress and read the report at /research?run=${id}. Tell the user it's running and link them there; don't wait for it here.`,
          sources: NO_SOURCES,
        };
      },
    }),
  ],
};
