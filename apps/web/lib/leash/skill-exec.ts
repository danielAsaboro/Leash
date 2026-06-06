/**
 * Skill script execution (server-only) — runs a skill's bundled `scripts/*` file as a
 * child process and returns its output to the model (`run_skill_script` tool).
 *
 * THIS IS REAL CODE EXECUTION as the web-app user, NOT a sandbox: the child keeps
 * network access and can read whatever the user can. Mitigations (defense in depth,
 * honestly bounded): imported skills land disabled; only ENABLED skills run; only files
 * under `<skill>/scripts/` (realpath-contained, no symlink escape); interpreter chosen
 * by EXTENSION only (no shebang trust, no shell); argv-array spawn; stripped env
 * (PATH/HOME/LANG/TMPDIR); 60 s SIGKILL timeout; output capped at 16 KB per stream;
 * and the chat layer gates every call behind a human approval card by default
 * (`run_skill_script` is in DEFAULT_ASK_FIRST).
 */
import "server-only";
import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { join, extname, sep } from "node:path";
import { getSkill, safeRelPath, SKILLS_DIR } from "./skills-store.ts";

const TIMEOUT_MS = 60_000;
const OUTPUT_CAP = 16 * 1024;
const MAX_ARGS = 16;
const MAX_ARG_LEN = 500;

/** Interpreter by extension ONLY — anything else is an honest "can't run this" error. */
const INTERPRETERS: Record<string, string> = {
  ".js": process.execPath,
  ".mjs": process.execPath,
  ".cjs": process.execPath,
  ".py": "python3",
  ".sh": "bash",
};

export interface ScriptResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Set when the script never ran (bad path, disabled skill, timeout, spawn failure …). */
  error?: string;
}

function cap(label: string, text: string): string {
  return text.length > OUTPUT_CAP ? text.slice(0, OUTPUT_CAP) + `\n…(${label} truncated at 16 KB of ${text.length} chars)` : text;
}

/** Run `<skill>/scripts/<script>` with argv `args`. Never throws — errors are in the result. */
export async function runSkillScript(slug: string, script: string, args: string[] = []): Promise<ScriptResult> {
  const fail = (error: string): ScriptResult => ({ ok: false, exitCode: null, stdout: "", stderr: "", error });

  const skill = await getSkill(slug);
  if (!skill) return fail(`no skill "${slug}"`);
  if (!skill.enabled) return fail(`the skill "${slug}" is disabled — enable it in the dashboard before running its scripts`);

  const rel = safeRelPath(script);
  if (!rel || !rel.startsWith("scripts/")) return fail(`scripts must live under the skill's scripts/ folder (got "${script}")`);
  if (args.length > MAX_ARGS) return fail(`too many arguments (${args.length} > ${MAX_ARGS})`);
  if (args.some((a) => typeof a !== "string" || a.length > MAX_ARG_LEN)) return fail(`arguments must be strings of at most ${MAX_ARG_LEN} chars`);

  // Realpath containment: the script's REAL location must stay under <skill>/scripts
  // (a symlink pointing outside the folder is rejected even though the path looks right).
  const skillDir = join(SKILLS_DIR, slug);
  let absReal: string;
  let scriptsReal: string;
  try {
    scriptsReal = await realpath(join(skillDir, "scripts"));
    absReal = await realpath(join(skillDir, rel));
  } catch {
    return fail(`the skill "${slug}" has no script "${rel}"`);
  }
  if (absReal !== scriptsReal && !absReal.startsWith(scriptsReal + sep)) return fail(`"${rel}" escapes the skill's scripts/ folder`);

  const interpreter = INTERPRETERS[extname(rel).toLowerCase()];
  if (!interpreter) {
    return fail(`can't run "${rel}" — supported script types are ${Object.keys(INTERPRETERS).join(", ")} (interpreter is chosen by extension)`);
  }

  // Stripped child env — only the basics a well-behaved script needs (no secrets leak).
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "LANG", "TMPDIR"]) {
    const v = process.env[key];
    if (v) env[key] = v;
  }

  return new Promise<ScriptResult>((resolvePromise) => {
    const child = spawn(interpreter, [absReal, ...args], {
      cwd: skillDir,
      timeout: TIMEOUT_MS,
      killSignal: "SIGKILL",
      env: env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"] as const,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      if (stdout.length < OUTPUT_CAP * 2) stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      if (stderr.length < OUTPUT_CAP * 2) stderr += c.toString("utf8");
    });
    child.on("error", (err) => {
      resolvePromise(fail(`couldn't start ${interpreter}: ${err.message}`));
    });
    child.on("close", (code, signal) => {
      resolvePromise({
        ok: code === 0,
        exitCode: code,
        stdout: cap("stdout", stdout),
        stderr: cap("stderr", stderr),
        ...(signal === "SIGKILL" ? { error: `script killed after ${TIMEOUT_MS / 1000}s timeout` } : {}),
      });
    });
  });
}
