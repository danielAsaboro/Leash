/**
 * Files tool group — a SANDBOXED read-only `bash` over an in-memory snapshot of the user's
 * files (grep/find/cat/ls/jq + `date`), for filesystem context retrieval. just-bash can't run
 * inside Next's RSC runtime, so (as in the web) every call runs out-of-process via
 * `apps/web/scripts/bash-exec.mts`. Read-only — it can't touch the real disk, so no approval.
 */
import { z } from "zod";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { REPO_ROOT } from "../paths.ts";
import type { LeashSource } from "../sources.ts";
import { defineTool, type ToolGroup } from "./types.ts";

/** Root the sandbox snapshots. Defaults to home; narrow for speed. */
const BASH_ROOT = process.env["LEASH_BASH_ROOT"] ?? homedir();
const CHILD = "apps/web/scripts/bash-exec.mts";
const TIMEOUT_MS = 20_000;
const NO_SOURCES: LeashSource[] = [];

interface ChildResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: string;
  truncated?: boolean;
}

const REAL_SHELL_ONLY_PATTERNS: RegExp[] = [
  /\b(?:curl|wget|ssh|scp|rsync|ftp|sftp|gh|brew)\b/i,
  /\b(?:git\s+(?:clone|pull|fetch|push|checkout|switch|merge|rebase|reset|restore|stash|clean|apply|am|submodule|worktree|init))\b/i,
  /\b(?:(?:npm|yarn|pnpm|bun|npx|pnpx)\s+(?:install|add|remove|upgrade|update|create|dlx|exec|run\s+\S+|build|dev|start|test|lint))\b/i,
  /\b(?:node|tsx|ts-node|python(?:3)?|pip(?:3)?|uv|poetry|ruby|bundle|php|java|cargo|go|rustc|make|cmake|docker|podman|osascript)\b/i,
  /(^|[;&|]\s*|\s)(?:rm|mv|cp|mkdir|touch|chmod|chown|ln|kill|pkill|nohup)\b/i,
  /(^|[;&|]\s*|\s)tee\b/i,
  /(^|[;&|]\s*|\s)\d*>>?\s*\S/,
  /(^|[;&|]\s*)sed\s+-i\b/i,
  /(^|[;&|]\s*)perl\s+-i\b/i,
  /(^|[;&|]\s*)patch\b/i,
  /(^|[;&|]\s*)source\b/i,
  /(^|[;&|]\s*)\.\s+\S+/,
  /&\s*$/,
];

function realShellOnlyMessage(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return "The `bash` tool needs a command to inspect the snapshot.";
  if (!REAL_SHELL_ONLY_PATTERNS.some((re) => re.test(trimmed))) return null;
  return (
    "The `bash` tool is a read-only snapshot inspector. Do not use it for installs, builds, starts, network fetches, or real file/process changes. " +
    "Use the user's explicit approval path outside the Files lane for real disk edits or process control."
  );
}

/** Spawn the out-of-process sandbox (tsx child), send the request on stdin, parse its JSON. */
function runChild(req: { op: "bash"; command?: string }): Promise<ChildResult> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", CHILD], { cwd: REPO_ROOT, env: { ...process.env, LEASH_BASH_ROOT: BASH_ROOT } });
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

export const filesGroup: ToolGroup = {
  id: "files",
  label: "Files",
  description: "Sandboxed read-only file retrieval over an in-memory snapshot of the user's files (grep/find/cat/jq + date).",
  tools: [
    defineTool({
      name: "bash",
      description:
        "Run a SANDBOXED read-only shell: inspect the user's files (grep/find/cat/ls/head/wc/sed/awk/jq) and check the current date/time (`date`). Use this to read files and to answer time/date questions. Inspection only: not for installs, builds, starts, network fetches, or real file changes. Returns the command output.",
      inputSchema: {
        command: z.string().describe("Shell command, e.g. `grep -rni \"budget\" .` or `find . -name '*.md'`."),
      },
      handler: async ({ command }) => {
        const msg = realShellOnlyMessage(command);
        if (msg) return { text: msg, sources: NO_SOURCES };
        return { text: render(await runChild({ op: "bash", command })), sources: NO_SOURCES };
      },
    }),
  ],
};
