/**
 * Computer-use tools (server-only) — let the assistant see and act on this Mac,
 * driven by a LOCAL or mesh-delegated QVAC model. Cloud provider-defined computer-use
 * tools (e.g. Anthropic's) would route the deciding model through a third-party API
 * and disqualify the hackathon submission — these are native AI SDK `tool()`s instead.
 *
 *   screenshot   — capture the screen → the on-device VLM answers a question about it
 *   run_command  — shell command (`bash -c`), approval-gated
 *   read_file    — text file read under COMPUTER_ROOT (hard-jailed)
 *   write_file   — text file create/replace, approval-gated
 *   edit_file    — exact-str-replace edit with uniqueness check, approval-gated
 *   computer     — mouse/keyboard via cliclick, approval-gated (experimental)
 *
 * Same `{ text, sources }` contract as tools.ts. The screenshot VLM round-trip passes
 * NO abortSignal (the qvac serve wedges on client aborts — see chat/route.ts); the
 * captured PNG is deleted in `finally` and only ever reaches the local/mesh QVAC VLM.
 */
import "server-only";
import { tool, generateText } from "ai";
import { z } from "zod";
import { captureScreen, CaptureError } from "./capture.ts";
import { runCommand, readTextFile, writeTextFile, editTextFile, runCliclick, COMPUTER_ROOT, TYPE_MAX, type ExecResult } from "./computer-exec.ts";
import { visionModel, VISION_MODEL } from "./provider.ts";
import type { LeashSource } from "./tools.ts";

const NO_SOURCES = [] as LeashSource[];

/** Honest one-blob rendering of an ExecResult for the model. */
function execText(r: ExecResult): string {
  if (r.exitCode === null && r.error) return r.error; // never ran (containment refusal, spawn failure, timeout)
  const out = r.stdout.trim();
  const err = r.stderr.trim();
  return [
    r.ok ? "Command succeeded (exit 0)." : `Command failed (exit ${r.exitCode ?? "?"})${r.error ? ` — ${r.error}` : ""}.`,
    out ? `stdout:\n${out}` : "",
    err ? `stderr:\n${err}` : "",
    !out && !err ? "(no output)" : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export const computerTools = {
  // NOTE: descriptions are deliberately TERSE. The serve assembles every offered tool
  // schema into a 4096-token prompt (qwen3-4b ctx_size) — verbose descriptions wedged
  // it at zero tokens on 2026-06-07. Full docs live in the README, not here.
  screenshot: tool({
    description:
      "Capture the user's screen; the on-device vision model answers a question about what's visible. Use to SEE the screen before and after acting. Returns text.",
    inputSchema: z.object({
      question: z.string().optional().describe("What to look for on screen (default: describe it)."),
    }),
    execute: async ({ question }) => {
      let frame: string;
      try {
        frame = await captureScreen();
      } catch (err) {
        return { text: err instanceof CaptureError ? err.message : `screen capture failed: ${String(err).slice(0, 200)}`, sources: NO_SOURCES };
      }
      try {
        // EXACTLY the watcher's proven request shape — the only qwen3vl cell that works
        // on this serve (verified 2026-06-07 across 4 repros + hundreds of watcher ticks):
        //   · NON-streaming (stream=true hangs at zero tokens after the image decodes,
        //     with or without max_tokens — needs a serve restart to recover)
        //   · NO maxOutputTokens (stream=false + max_tokens → 500 after the decode)
        //   · maxRetries 0 — every failed attempt re-pays the ~40 s image encode
        // The model stops naturally (~50-100 tokens). NO abortSignal (wedge rule).
        const { text } = await generateText({
          model: visionModel(),
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: question?.trim() || "Describe the screen: the frontmost app, window titles, and the main visible content." },
                { type: "image", image: frame },
              ],
            },
          ],
          maxRetries: 0,
        });
        return { text: text.trim() || `the vision model (${VISION_MODEL}) returned no text for this frame`, sources: NO_SOURCES };
      } catch (err) {
        return { text: `screen captured, but the vision model (${VISION_MODEL}) failed: ${err instanceof Error ? err.message : String(err)}`, sources: NO_SOURCES };
      }
    },
  }),

  run_command: tool({
    description: "Run a shell command on this Mac (bash) and return its output. Pauses for the user's approval.",
    inputSchema: z.object({
      command: z.string().describe("Shell command, e.g. `ls -la ~/Documents`."),
      cwd: z.string().optional().describe("Working directory (default: home)."),
    }),
    execute: async ({ command, cwd }) => ({ text: execText(await runCommand(command, cwd)), sources: NO_SOURCES }),
  }),

  read_file: tool({
    description: "Read a text file on this Mac by path (~/…, absolute, or relative to home).",
    inputSchema: z.object({
      path: z.string().describe("File path, e.g. `~/.zshrc`."),
    }),
    execute: async ({ path }) => {
      const r = await readTextFile(path);
      return { text: r.ok ? r.text : r.error, sources: NO_SOURCES };
    },
  }),

  write_file: tool({
    description: "Create or replace a text file on this Mac (parents created). Pauses for the user's approval. To change part of a file, prefer edit_file.",
    inputSchema: z.object({
      path: z.string().describe("File path, e.g. `~/leash-test.txt`."),
      content: z.string().describe("Full text content."),
    }),
    execute: async ({ path, content }) => {
      const r = await writeTextFile(path, content);
      return { text: r.ok ? `${r.replaced ? "Replaced" : "Created"} ${r.path} (${content.length} chars).` : r.error, sources: NO_SOURCES };
    },
  }),

  edit_file: tool({
    description: "Edit a text file by exact replacement: old_str must match exactly once (read_file first, copy exactly). Pauses for the user's approval.",
    inputSchema: z.object({
      path: z.string().describe("File path."),
      old_str: z.string().describe("Exact existing text — must occur exactly once."),
      new_str: z.string().describe("Replacement text."),
    }),
    execute: async ({ path, old_str, new_str }) => {
      const r = await editTextFile(path, old_str, new_str);
      return { text: r.ok ? `Edited ${r.path}.` : r.error, sources: NO_SOURCES };
    },
  }),

  computer: tool({
    description:
      "EXPERIMENTAL — drive the mouse/keyboard via cliclick. move/click/double_click need x,y in logical points (on Retina, screenshot pixels ÷ 2); " +
      "key presses one key (return, tab, esc, arrow-down, page-down…); scroll pages down (+) or up (−). Screenshot before to aim, after to verify. Pauses for the user's approval.",
    inputSchema: z.object({
      action: z.enum(["move", "click", "double_click", "type", "key", "scroll"]).describe("What to do."),
      x: z.number().int().min(0).optional().describe("X (logical points)."),
      y: z.number().int().min(0).optional().describe("Y (logical points)."),
      text: z.string().optional().describe("Text to type."),
      key: z.string().optional().describe("Key name, e.g. `return`."),
      amount: z.number().int().min(-10).max(10).optional().describe("Scroll pages: + down, − up."),
    }),
    execute: async ({ action, x, y, text, key, amount }) => {
      const done = (t: string) => ({ text: t, sources: NO_SOURCES });
      switch (action) {
        case "move":
        case "click":
        case "double_click": {
          if (x == null || y == null) return done(`action "${action}" needs both x and y (logical screen points).`);
          const op = action === "move" ? "m" : action === "click" ? "c" : "dc";
          const r = await runCliclick([`${op}:${x},${y}`]);
          return done(r.ok ? `${action} at ${x},${y} done.` : execText(r));
        }
        case "type": {
          const t = text ?? "";
          if (!t) return done('action "type" needs `text`.');
          if (t.length > TYPE_MAX) return done(`text too long to type (${t.length} > ${TYPE_MAX} chars) — split it up.`);
          const r = await runCliclick([`t:${t}`]);
          return done(r.ok ? `typed ${t.length} chars.` : execText(r));
        }
        case "key": {
          if (!key?.trim()) return done('action "key" needs `key` (e.g. `return`, `tab`, `arrow-down`).');
          const r = await runCliclick([`kp:${key.trim()}`]);
          return done(r.ok ? `pressed ${key.trim()}.` : execText(r));
        }
        case "scroll": {
          const n = amount === 0 || amount == null ? 1 : amount;
          const keyName = n < 0 ? "page-up" : "page-down";
          const r = await runCliclick(Array.from({ length: Math.abs(n) }, () => `kp:${keyName}`));
          return done(r.ok ? `scrolled ${Math.abs(n)} page${Math.abs(n) === 1 ? "" : "s"} ${n < 0 ? "up" : "down"} (page-key).` : execText(r));
        }
      }
    },
  }),
};
