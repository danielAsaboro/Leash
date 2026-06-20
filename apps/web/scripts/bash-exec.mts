/**
 * Out-of-process bash sandbox (just-bash via Vercel's bash-tool) — runs in a spawned `tsx`
 * child, NEVER inside Next. just-bash installs an Error.prepareStackTrace guard that crashes
 * Next's RSC runtime (verified 2026-06-11); in a plain Node child it runs fine. `bash-tools.ts`
 * spawns this per tool call.
 *
 * Protocol:  stdin  = JSON { op: "bash"|"readFile", command?, path? }
 *            argv    = (none)        env LEASH_BASH_ROOT (or home)
 *            stdout  = JSON { ok, stdout?, stderr?, exitCode?, error?, included?, truncated? }
 *
 * The snapshot is cached to a temp file (60s TTL) so a multi-command retrieval turn doesn't
 * re-walk the user's home for every grep.
 */
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createBashTool } from "bash-tool";
import { buildSnapshot, type Snapshot } from "../lib/leash/bash-snapshot.ts";
import { BASH_SNAPSHOT_TOOL_PROMPT } from "../lib/leash/prompt.ts";

const TTL_MS = 60_000;
const ROOT = process.env["LEASH_BASH_ROOT"] ?? homedir();
const SNAP_FILE = join(tmpdir(), `leash-bash-snap-${createHash("sha1").update(ROOT).digest("hex").slice(0, 12)}.json`);

function out(o: unknown): never {
  process.stdout.write(JSON.stringify(o));
  process.exit(0);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Cached snapshot: reuse the temp file if it's fresh, else walk + persist it. */
async function loadSnapshot(): Promise<Snapshot> {
  try {
    const age = Date.now() - (await stat(SNAP_FILE)).mtimeMs;
    if (age < TTL_MS) return JSON.parse(await readFile(SNAP_FILE, "utf8")) as Snapshot;
  } catch {
    /* missing/stale — rebuild */
  }
  const snap = await buildSnapshot(ROOT);
  await writeFile(SNAP_FILE, JSON.stringify(snap)).catch(() => {});
  return snap;
}

async function main(): Promise<void> {
  let req: { op?: string; command?: string; path?: string };
  try {
    req = JSON.parse((await readStdin()) || "{}");
  } catch {
    out({ ok: false, error: "invalid request JSON" });
  }

  const snap = await loadSnapshot();
  // destination "." → files land at the sandbox root, so both `executeCommand` (cwd = root) and
  // `readFile(relpath)` resolve the same relative paths (default "./workspace" desyncs them).
  const { sandbox } = await createBashTool({ files: snap.files, destination: ".", maxFiles: 0, promptOptions: { toolPrompt: BASH_SNAPSHOT_TOOL_PROMPT } });

  try {
    if (req.op === "readFile") {
      if (!req.path) out({ ok: false, error: "readFile needs a path" });
      const text = await sandbox.readFile(req.path as string);
      out({ ok: true, stdout: text, included: snap.included, truncated: snap.truncated });
    }
    // default: bash
    const command = (req.command ?? "").trim();
    if (!command) out({ ok: false, error: "bash needs a command" });
    const r = await sandbox.executeCommand(command);
    out({ ok: r.exitCode === 0, stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, included: snap.included, truncated: snap.truncated });
  } catch (e) {
    out({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

void main().catch((e) => out({ ok: false, error: e instanceof Error ? e.message : String(e) }));
