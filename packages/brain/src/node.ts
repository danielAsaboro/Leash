import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");

export const BRAIN_BUILTIN_AGENTS_DIR = join(packageRoot, "builtin-agents");
export const BRAIN_BUILTIN_SKILLS_DIR = join(packageRoot, "builtin-skills");

export interface MaterializedBrainBuiltins {
  agentsDir: string;
  skillsDir: string;
}

export async function materializeBrainBuiltins(destination: string): Promise<MaterializedBrainBuiltins> {
  const agentsDir = join(destination, "builtin-agents");
  const skillsDir = join(destination, "builtin-skills");
  await mkdir(destination, { recursive: true });
  await cp(BRAIN_BUILTIN_AGENTS_DIR, agentsDir, { recursive: true });
  await cp(BRAIN_BUILTIN_SKILLS_DIR, skillsDir, { recursive: true });
  return { agentsDir, skillsDir };
}
