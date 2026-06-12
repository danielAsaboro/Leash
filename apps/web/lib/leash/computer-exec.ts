/**
 * Computer-use execution (server-only) — the containment layer behind the computer-use
 * tools (`run_command` / `read_file` / `write_file` / `edit_file` / `computer`).
 *
 * THIS IS REAL EXECUTION ON THE USER'S MAC, honestly bounded, NOT a perfect sandbox:
 *
 *   · File ops (read/write/edit) are HARD-JAILED under `COMPUTER_ROOT` (default: the
 *     user's home; narrow via `LEASH_COMPUTER_ROOT`) with realpath containment — a
 *     symlink pointing outside the root is rejected even when the path looks right.
 *   · `run_command` is NOT a hard jail: its cwd is contained for convenience, but an
 *     approved shell command runs as the user and can touch anything the user can.
 *     The real boundary is the chat layer's human approval card (DEFAULT_ASK_FIRST)
 *     plus a stripped env (PATH/HOME/LANG/TMPDIR by default — secrets never leak), a
 *     SIGKILL timeout (`LEASH_COMMAND_TIMEOUT_MS`, default 60 s — raise it for slow
 *     installs/builds), and output caps. `LEASH_COMMAND_ALLOW` (comma-separated first
 *     tokens) is a best-effort guard-rail — `bash -c` composability means it is NOT a
 *     security boundary. Workspace config (`LEASH_MCP_REPOS_DIR`, plus any names in
 *     `LEASH_COMMAND_ENV`) is passed through so skills can resolve install paths.
 *   · `runCliclick` drives the GUI via the `cliclick` binary (argv-array spawn, no
 *     shell); a missing binary gets an honest install hint instead of a crash.
 *
 * Limits mirror `skill-exec.ts` (same caps, same stripped env, same kill discipline).
 */
import "server-only";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, dirname, sep } from "node:path";

/** The file-op jail root (and `run_command`'s default cwd). Default: the user's home. */
export const COMPUTER_ROOT = process.env["LEASH_COMPUTER_ROOT"] ?? homedir();

/** SIGKILL timeout for a single command. Default 60 s; raise for slow installs/builds. */
const TIMEOUT_MS = Number(process.env["LEASH_COMMAND_TIMEOUT_MS"] ?? 60_000);
const OUTPUT_CAP = 16 * 1024;
const READ_CAP = 64 * 1024;
const WRITE_CAP = 1024 * 1024;
const COMMAND_MAX = 4096;
/** Max characters the `computer` tool may type in one action. */
export const TYPE_MAX = 500;

export interface ExecResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process never ran usefully (containment refusal, timeout, spawn failure …). */
  error?: string;
}

const fail = (error: string): ExecResult => ({ ok: false, exitCode: null, stdout: "", stderr: "", error });

function cap(label: string, text: string): string {
  return text.length > OUTPUT_CAP ? text.slice(0, OUTPUT_CAP) + `\n…(${label} truncated at 16 KB of ${text.length} chars)` : text;
}

/**
 * Stripped child env — only the basics a well-behaved process needs, so no secrets leak
 * into approved commands. Beyond the base set we pass through WORKSPACE config a skill may
 * need to resolve install paths (`LEASH_MCP_REPOS_DIR`), plus any extra names an operator
 * allow-lists via `LEASH_COMMAND_ENV` (comma-separated). These are non-secret config knobs;
 * keep secrets (tokens, keys) out of this list.
 */
const ENV_PASSTHROUGH: string[] = [
  "LEASH_MCP_REPOS_DIR",
  ...(process.env["LEASH_COMMAND_ENV"] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
];

function strippedEnv(): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "LANG", "TMPDIR", ...ENV_PASSTHROUGH]) {
    const v = process.env[key];
    if (v) env[key] = v;
  }
  return env as NodeJS.ProcessEnv;
}

/**
 * Resolve `p` (absolute, `~/…`, or relative-to-root) with symlink containment under
 * `root`: the resolved REAL path (of the file, or of its nearest existing ancestor for
 * to-be-created files) must stay under the root's real path. Null when it escapes.
 * Generalizes `skills-store.ts`'s `containedPath` to arbitrary roots/paths.
 */
export async function containedUnder(root: string, p: string): Promise<string | null> {
  const trimmed = p.trim();
  if (!trimmed || trimmed.length > 1024) return null;
  const expanded = trimmed === "~" ? homedir() : trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(2)) : trimmed;
  const abs = resolve(root, expanded);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    return null; // no root directory
  }
  // Walk up to the nearest EXISTING ancestor and realpath that (the file itself may not exist yet).
  let probe = abs;
  for (;;) {
    try {
      const real = await realpath(probe);
      const tail = abs.slice(probe.length); // "" when probe === abs
      const full = real + tail;
      return full === rootReal || full.startsWith(rootReal + sep) ? abs : null;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
  }
}

/** Spawn + collect with the shared caps/timeout. `enoentHint` personalizes a missing binary. */
function runProcess(cmd: string, args: string[], opts: { cwd?: string; enoentHint?: string }): Promise<ExecResult> {
  return new Promise<ExecResult>((resolvePromise) => {
    const child = spawn(cmd, args, {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      timeout: TIMEOUT_MS,
      killSignal: "SIGKILL",
      env: strippedEnv(),
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
      const enoent = (err as NodeJS.ErrnoException).code === "ENOENT" && opts.enoentHint;
      resolvePromise(fail(enoent ? (opts.enoentHint as string) : `couldn't start ${cmd}: ${err.message}`));
    });
    child.on("close", (code, signal) => {
      resolvePromise({
        ok: code === 0,
        exitCode: code,
        stdout: cap("stdout", stdout),
        stderr: cap("stderr", stderr),
        ...(signal === "SIGKILL" ? { error: `killed after ${TIMEOUT_MS / 1000}s timeout` } : {}),
      });
    });
  });
}

/**
 * Run a shell command (`bash -c`) with cwd contained under `COMPUTER_ROOT`. Never
 * throws — every failure mode lands in the result. See the module header for the
 * honest boundary (approval card, not the cwd jail).
 */
export async function runCommand(command: string, cwd?: string): Promise<ExecResult> {
  const cmd = command.trim();
  if (!cmd) return fail("empty command");
  if (cmd.length > COMMAND_MAX) return fail(`command too long (${cmd.length} > ${COMMAND_MAX} chars)`);

  // Optional first-token allowlist (best-effort guard-rail, NOT a security boundary).
  const allow = (process.env["LEASH_COMMAND_ALLOW"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (allow.length > 0) {
    const first = cmd.split(/\s+/)[0] ?? "";
    if (!allow.includes(first)) return fail(`command "${first}" is not in LEASH_COMMAND_ALLOW (${allow.join(", ")})`);
  }

  let dir = COMPUTER_ROOT;
  if (cwd?.trim()) {
    const contained = await containedUnder(COMPUTER_ROOT, cwd);
    if (!contained) return fail(`cwd "${cwd}" is outside the allowed root (${COMPUTER_ROOT})`);
    try {
      if (!(await stat(contained)).isDirectory()) return fail(`cwd "${cwd}" is not a directory`);
    } catch {
      return fail(`cwd "${cwd}" does not exist`);
    }
    dir = contained;
  }

  return runProcess("bash", ["-c", cmd], { cwd: dir });
}

/** Read a text file under `COMPUTER_ROOT` (64 KB cap; honest message for binary content). */
export async function readTextFile(path: string): Promise<{ ok: true; text: string; path: string } | { ok: false; error: string }> {
  const abs = await containedUnder(COMPUTER_ROOT, path);
  if (!abs) return { ok: false, error: `"${path}" is outside the allowed root (${COMPUTER_ROOT}) — only files under it can be read` };
  let buf: Buffer;
  try {
    buf = await readFile(abs);
  } catch {
    return { ok: false, error: `no readable file at "${path}"` };
  }
  if (buf.subarray(0, 8000).includes(0)) return { ok: false, error: `"${path}" is a binary file (${buf.length} bytes) — only text files can be read` };
  const text = buf.toString("utf8");
  return { ok: true, path: abs, text: text.length > READ_CAP ? text.slice(0, READ_CAP) + `\n…(truncated at 64 KB of ${text.length} chars)` : text };
}

/** Create/replace a text file under `COMPUTER_ROOT` (1 MB cap; parents are created). */
export async function writeTextFile(path: string, content: string): Promise<{ ok: true; path: string; replaced: boolean } | { ok: false; error: string }> {
  if (content.length > WRITE_CAP) return { ok: false, error: `content too large (${content.length} > ${WRITE_CAP} chars)` };
  const abs = await containedUnder(COMPUTER_ROOT, path);
  if (!abs) return { ok: false, error: `"${path}" is outside the allowed root (${COMPUTER_ROOT}) — only files under it can be written` };
  let replaced = false;
  try {
    const st = await stat(abs);
    if (st.isDirectory()) return { ok: false, error: `"${path}" is a directory` };
    replaced = true;
  } catch {
    /* new file */
  }
  try {
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  } catch (err) {
    return { ok: false, error: `write failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, path: abs, replaced };
}

/**
 * Str-replace edit with a uniqueness check: `old_str` must match EXACTLY ONCE
 * (0 → not found, >1 → ambiguous — both honest errors telling the model what to fix).
 */
export async function editTextFile(path: string, oldStr: string, newStr: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  if (!oldStr) return { ok: false, error: "old_str is empty — pass the exact text to replace" };
  const abs = await containedUnder(COMPUTER_ROOT, path);
  if (!abs) return { ok: false, error: `"${path}" is outside the allowed root (${COMPUTER_ROOT}) — only files under it can be edited` };
  let buf: Buffer;
  try {
    buf = await readFile(abs);
  } catch {
    return { ok: false, error: `no readable file at "${path}"` };
  }
  if (buf.subarray(0, 8000).includes(0)) return { ok: false, error: `"${path}" is a binary file — only text files can be edited` };
  if (buf.length > WRITE_CAP) return { ok: false, error: `"${path}" is too large to edit (${buf.length} > ${WRITE_CAP} bytes)` };
  const text = buf.toString("utf8");
  const count = text.split(oldStr).length - 1;
  if (count === 0) return { ok: false, error: `old_str not found in "${path}" — read the file and pass the exact text (whitespace included)` };
  if (count > 1) return { ok: false, error: `old_str matches ${count} places in "${path}" — include surrounding lines to make it unique` };
  const next = text.replace(oldStr, newStr);
  if (next.length > WRITE_CAP) return { ok: false, error: `edited content too large (${next.length} > ${WRITE_CAP} chars)` };
  try {
    await writeFile(abs, next, "utf8");
  } catch (err) {
    return { ok: false, error: `write failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, path: abs };
}

/** Drive the GUI via `cliclick` (argv-array, no shell). Missing binary → honest install hint. */
export async function runCliclick(args: string[]): Promise<ExecResult> {
  return runProcess("cliclick", args, {
    enoentHint: "cliclick is not installed — run `brew install cliclick`, then grant Accessibility permission to this terminal (System Settings → Privacy & Security → Accessibility).",
  });
}
