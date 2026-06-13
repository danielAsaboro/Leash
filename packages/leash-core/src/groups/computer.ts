/**
 * Computer-use tool group — see and act on this Mac, driven by a LOCAL/mesh QVAC model
 * (never a cloud computer-use API — that would disqualify the hackathon).
 *
 *   screenshot   — capture the screen → the on-device VLM answers a question about it
 *   run_command  — shell command (`bash -c`), approval-gated; the real-disk executor
 *   computer     — mouse/keyboard via cliclick, approval-gated (experimental)
 */
import { z } from "zod";
import { generateText } from "ai";
import { captureScreen, CaptureError } from "../capture.ts";
import { runCommand, runCliclick, TYPE_MAX, type ExecResult } from "../computer-exec.ts";
import { visionModel, VISION_MODEL } from "../provider-core.ts";
import type { LeashSource } from "../sources.ts";
import { defineTool, type ToolGroup } from "./types.ts";

const NO_SOURCES: LeashSource[] = [];

/** Honest one-blob rendering of an ExecResult for the model. */
function execText(r: ExecResult): string {
  if (r.exitCode === null && r.error) return r.error;
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

export const computerGroup: ToolGroup = {
  id: "computer",
  label: "Computer Use",
  description: "See and act on this Mac: screenshot (on-device VLM), run_command (approval-gated shell), computer (mouse/keyboard).",
  tools: [
    // Terse descriptions: the serve packs every offered tool schema into a 4096-token prompt.
    defineTool({
      name: "screenshot",
      description: "Capture the user's screen; the on-device vision model answers a question about what's visible. Use to SEE the screen before and after acting. Returns text.",
      inputSchema: {
        question: z.string().optional().describe("What to look for on screen (default: describe it)."),
      },
      handler: async ({ question }) => {
        let frame: string;
        try {
          frame = await captureScreen();
        } catch (err) {
          return { text: err instanceof CaptureError ? err.message : `screen capture failed: ${String(err).slice(0, 200)}`, sources: NO_SOURCES };
        }
        try {
          // EXACTLY the watcher's proven request shape (non-streaming, no maxOutputTokens,
          // maxRetries 0, NO abortSignal — the wedge rule). The model stops naturally.
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

    defineTool({
      name: "run_command",
      needsApproval: true,
      description:
        "Run a shell command string on this Mac (bash) and return its output. The real-disk executor: read a file with `cat`, create/replace with a heredoc (`cat > file <<'EOF' … EOF`) or `tee`, edit in place with `sed -i`/`patch`, plus installs/builds. Inputs are `command` and optional `cwd` only. Pauses for the user's approval.",
      inputSchema: {
        command: z.string().describe("Full shell command string, e.g. `ls -la ~/Documents`. Do not split into args."),
        cwd: z.string().optional().describe("Optional working directory (default: home)."),
      },
      handler: async ({ command, cwd }) => ({ text: execText(await runCommand(command, cwd)), sources: NO_SOURCES }),
    }),

    defineTool({
      name: "computer",
      needsApproval: true,
      description:
        "EXPERIMENTAL — drive the mouse/keyboard via cliclick. move/click/double_click need x,y in logical points (on Retina, screenshot pixels ÷ 2); " +
        "key presses one key (return, tab, esc, arrow-down, page-down…); scroll pages down (+) or up (−). Screenshot before to aim, after to verify. Pauses for the user's approval.",
      inputSchema: {
        action: z.enum(["move", "click", "double_click", "type", "key", "scroll"]).describe("What to do."),
        x: z.number().int().min(0).optional().describe("X (logical points)."),
        y: z.number().int().min(0).optional().describe("Y (logical points)."),
        text: z.string().optional().describe("Text to type."),
        key: z.string().optional().describe("Key name, e.g. `return`."),
        amount: z.number().int().min(-10).max(10).optional().describe("Scroll pages: + down, − up."),
      },
      handler: async ({ action, x, y, text, key, amount }) => {
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
          default:
            return done(`unknown action "${String(action)}".`);
        }
      },
    }),
  ],
};
