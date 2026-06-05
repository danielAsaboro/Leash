/**
 * The deep-research chat tool (server-only) — `deep_research(question)` kicks off a
 * detached research run and returns its id + the /research link. It does NOT block the
 * turn waiting for the (multi-minute) run — honest about the async nature, the way the
 * model-download tool is.
 */
import "server-only";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { generateId } from "ai";
import { DATA_DIR } from "./json-store.ts";
import type { LeashSource } from "./tools.ts";

const ROOT = join(DATA_DIR, "..");
const SCRIPT = join(ROOT, "apps", "web", "scripts", "leash-research.mts");

export const researchTools = {
  deep_research: tool({
    description:
      "Start a DEEP RESEARCH run on a question: the system searches the live web, reads multiple sources, and synthesizes a cited report over several minutes. Use for questions that need current, multi-source web evidence (comparisons, 'what's the latest on…', surveys). It runs in the BACKGROUND — you get a link, not an immediate answer. (Needs network.)",
    inputSchema: z.object({
      question: z.string().describe("The research question to investigate."),
    }),
    execute: async ({ question }) => {
      const q = question.trim();
      if (!q) return { text: "Provide a research question.", sources: [] as LeashSource[] };
      const id = generateId();
      try {
        const child = spawn("npx", ["tsx", SCRIPT, id, q.slice(0, 500)], { cwd: ROOT, detached: true, stdio: "ignore" });
        child.unref();
      } catch (err) {
        return { text: `Couldn't start research: ${err instanceof Error ? err.message : err}`, sources: [] as LeashSource[] };
      }
      return {
        text: `Started a deep-research run on "${q}". It runs in the background (a few minutes) — follow progress and read the report at /research?run=${id}. Tell the user it's running and link them there; don't wait for it here.`,
        sources: [] as LeashSource[],
      };
    },
  }),
};
