/**
 * Sandboxed bash tools (server-only) — Vercel's `bash-tool` (just-bash) over a READ-ONLY
 * in-memory snapshot of the user's files, for filesystem-based context retrieval. The
 * PREFERRED surface for the assistant to search/read the user's files (grep/find/cat) — a
 * sandbox: it cannot touch the real disk, so no approval gate. (The real-disk read/write/
 * edit/run_command tools in `computer-tools.ts` stay for actual machine actions.)
 *
 * just-bash CANNOT run inside Next's RSC runtime — it installs an Error.prepareStackTrace
 * guard that CRASHES the process (verified 2026-06-11; works fine under plain Node). So,
 * following the repo's "spawn a tsx child for incompatible libs" rule, every tool call runs
 * the sandbox out-of-process via `scripts/bash-exec.mts`. Next never imports just-bash, and
 * never walks the filesystem — the child owns the (temp-file-cached) snapshot.
 *
 * Scope: `LEASH_BASH_ROOT` (default `COMPUTER_ROOT` = home). Two tools (`bash`, `readFile`)
 * activated only on the chat route's `files` lane (agent.ts) — never counting toward the
 * chat lane's ~22-schema cap.
 */
import "server-only";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { DATA_DIR } from "./json-store.ts";
import { COMPUTER_ROOT } from "./computer-exec.ts";

/** Root the sandbox snapshots. Defaults to the computer-use jail (home); narrow it for speed/focus. */
export const BASH_ROOT = process.env["LEASH_BASH_ROOT"] ?? COMPUTER_ROOT;

/** The tool names the agent's `files` lane activates. */
export const BASH_TOOL_NAMES = new Set(["bash", "readFile"]);

const ROOT = join(DATA_DIR, ".."); // mycelium repo root — cwd for the spawned child
const CHILD = "apps/web/scripts/bash-exec.mts";
const TIMEOUT_MS = 20_000;

interface ChildResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: string;
  truncated?: boolean;
}

/** Spawn the out-of-process sandbox (tsx child), send the request on stdin, parse its JSON. */
function runChild(req: { op: "bash" | "readFile"; command?: string; path?: string }): Promise<ChildResult> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", CHILD], { cwd: ROOT, env: { ...process.env, LEASH_BASH_ROOT: BASH_ROOT } });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, error: `bash sandbox timed out after ${TIMEOUT_MS / 1000}s` });
    }, TIMEOUT_MS);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `failed to spawn bash sandbox: ${e.message}` });
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(stdout) as ChildResult);
      } catch {
        resolve({ ok: false, error: stderr.trim() || "bash sandbox produced no parseable output" });
      }
    });
    child.stdin.write(JSON.stringify(req));
    child.stdin.end();
  });
}

/** One honest blob for the model: stdout (+ stderr / failure / truncation notes). */
function render(r: ChildResult): string {
  if (!r.ok && r.error) return r.error;
  const parts: string[] = [];
  if (r.stdout?.trim()) parts.push(r.stdout.trim());
  if (r.stderr?.trim()) parts.push(`stderr:\n${r.stderr.trim()}`);
  if (parts.length === 0) parts.push(r.ok ? "(no output)" : `command failed (exit ${r.exitCode ?? "?"})`);
  if (r.truncated) parts.push("[note: the file snapshot is capped — not every file under the root is present]");
  return parts.join("\n");
}

// Terse descriptions (the serve packs tool schemas into a 4096-token prompt — see computer-tools.ts).
const BASH_TOOLS: ToolSet = {
  bash: tool({
    description: "Search/read the user's files via a SANDBOXED shell over a read-only snapshot (grep/find/cat/ls/head/wc/sed/awk). Safe — can't touch the real disk. Returns the command output.",
    inputSchema: z.object({
      command: z.string().describe("Shell command, e.g. `grep -rni \"budget\" .` or `find . -name '*.md'`."),
    }),
    execute: async ({ command }) => ({ text: render(await runChild({ op: "bash", command })), sources: [] }),
  }),
  readFile: tool({
    description: "Read one file from the sandboxed read-only snapshot of the user's files, by relative path.",
    inputSchema: z.object({
      path: z.string().describe("Relative path within the snapshot, e.g. `notes/todo.md`."),
    }),
    execute: async ({ path }) => ({ text: render(await runChild({ op: "readFile", path })), sources: [] }),
  }),
};

/** The sandboxed retrieval tools. Cheap — no filesystem work happens until a tool actually runs (in the child). */
export async function buildBashTools(): Promise<ToolSet> {
  return BASH_TOOLS;
}

/** Static scope note for the dashboard (no child spawn — the live count lives in the child's snapshot). */
export function bashScopeNote(): string {
  return `Sandboxed retrieval — a read-only in-memory snapshot of your files under ${BASH_ROOT}, run in an isolated process; can't touch the real disk. Used on file-search turns.`;
}

/** Runtime self-test: run one command end-to-end through the child (proves the out-of-process path works). */
export async function bashSelfTest(): Promise<ChildResult> {
  return runChild({ op: "bash", command: "ls -1 | head -20" });
}
