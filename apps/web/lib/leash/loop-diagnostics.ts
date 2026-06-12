/**
 * Multi-step loop diagnostics (server-only) — a logging middleware that records what the
 * QVAC serve ACTUALLY returns per model call, so we can tell WHICH "stops after one step"
 * failure we have. The deep-research pass (2026-06-12) found three distinct root causes
 * with three different fixes, and they're indistinguishable from the outside:
 *
 *   A. finish_reason loop bug — serve returns finishReason:"stop" WITH tool calls present;
 *      a loop that keys off finishReason exits early. (Harness fix.)
 *   B. overthinking-overwrite — the model reaches a correct call mid-<think>, then keeps
 *      reasoning and overwrites it. (Decoding/think-budget fix.)
 *   C. Implicit Action Failure — the model emits a clean FINAL answer after step 1 and
 *      never attempts a 2nd call. (Plan/decompose fix.) finish_reason fix does NOT help.
 *
 * This middleware logs, per model call (= per loop step), the raw finishReason, the count
 * of tool-call parts, and whether text/reasoning was produced — then classifies the step so
 * a multi-step transcript reads at a glance. Zero behavior change: it only observes. Gated
 * behind LEASH_DEBUG_LOOP so it's silent in normal runs.
 */
import "server-only";
import { existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./json-store.ts";
import type { LanguageModelV2Middleware, LanguageModelV2StreamPart } from "@ai-sdk/provider";

/** Sentinel file flag (so an already-running dev server can be switched on without an env/restart).
 *  Anchored to DATA_DIR (module-relative, like every other store) — NOT process.cwd(), which is
 *  apps/web under `npm -w` and would miss the repo-root data/ dir. */
const FLAG_FILE = join(DATA_DIR, ".leash-debug-loop");
/** Where per-step lines are appended (readable regardless of which process/terminal runs the server). */
const LOG_FILE = process.env["LEASH_LOOP_LOG"] ?? "/tmp/leash-loop.log";

/** On when LEASH_DEBUG_LOOP is truthy OR the sentinel file exists (re-checked per call — no restart needed). */
export function loopDebugOn(): boolean {
  const v = process.env["LEASH_DEBUG_LOOP"];
  if (!!v && v !== "0" && v !== "false") return true;
  try {
    return existsSync(FLAG_FILE);
  } catch {
    return false;
  }
}

/** Emit a diagnostic line to BOTH the server console and the log file (best-effort). */
function emit(line: string): void {
  console.log(line);
  try {
    appendFileSync(LOG_FILE, line + "\n");
  } catch {
    /* log file is a convenience; never fail a turn over it */
  }
}

/** Public hook so other modules (e.g. the agent's prepareStep) can record events in the same loop log. */
export function loopLog(line: string): void {
  if (loopDebugOn()) emit(`leash[loop] ${new Date().toISOString()} ${line}`);
}

type StepShape = {
  finishReason: string;
  toolCalls: number;
  toolNames: string[];
  hasText: boolean;
  textLen: number;
  hasReasoning: boolean;
  reasoningLen: number;
};

/**
 * Classify a step into the A/B/C buckets above (best-effort — B needs the reasoning trace,
 * which we only flag as "long reasoning + a final call", the observable shadow of overwrite).
 */
function classify(s: StepShape): string {
  if (s.finishReason === "stop" && s.toolCalls > 0) return "A?(stop+toolcalls — loop-bug suspect)";
  if (s.toolCalls > 0) return "tool-step(ok)";
  if (s.finishReason === "stop" && s.hasText) {
    // No tool call, just a final answer. If the model reasoned heavily first, it may be the
    // overthinking-overwrite shadow (B); otherwise it's plain Implicit-Action-Failure (C).
    return s.hasReasoning && s.reasoningLen > 400 ? "C/B?(final answer after long think — no call)" : "C?(final answer — no call)";
  }
  return `other(finish=${s.finishReason})`;
}

function logStep(label: string, s: StepShape): void {
  const names = s.toolNames.length ? ` [${s.toolNames.join(", ")}]` : "";
  emit(
    `leash[loop] ${new Date().toISOString()} ${label} finish=${s.finishReason} toolCalls=${s.toolCalls}${names} ` +
      `text=${s.hasText ? s.textLen : 0} reasoning=${s.hasReasoning ? s.reasoningLen : 0} → ${classify(s)}`,
  );
}

/**
 * A diagnostic middleware. `label` distinguishes the main chat loop from a run_skill
 * sub-agent in the log. Observes both the streaming path (main route) and the non-streaming
 * path (run_skill's generateText).
 */
export function loopDiagnosticMiddleware(label: string): LanguageModelV2Middleware {
  return {
    // Non-streaming (run_skill sub-agent uses generateText).
    wrapGenerate: async ({ doGenerate }) => {
      const r = await doGenerate();
      try {
        const fr = r.finishReason as unknown;
        const finishReason = typeof fr === "string" ? fr : ((fr as { finishReason?: string })?.finishReason ?? (fr as { type?: string })?.type ?? JSON.stringify(fr));
        const content = (r.content ?? []) as Array<{ type: string; text?: string; toolName?: string }>;
        const toolParts = content.filter((c) => c.type === "tool-call");
        const textParts = content.filter((c) => c.type === "text");
        const reasoningParts = content.filter((c) => c.type === "reasoning");
        const textLen = textParts.reduce((n, c) => n + (c.text?.length ?? 0), 0);
        const reasoningLen = reasoningParts.reduce((n, c) => n + (c.text?.length ?? 0), 0);
        logStep(label, {
          finishReason,
          toolCalls: toolParts.length,
          toolNames: toolParts.map((c) => c.toolName ?? "?").filter(Boolean),
          hasText: textLen > 0,
          textLen,
          hasReasoning: reasoningLen > 0,
          reasoningLen,
        });
      } catch (e) {
        console.warn(`leash[loop] ${label} diagnostic(generate) failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return r;
    },

    // Streaming (main chat route uses streamText). Tap the stream WITHOUT consuming it: count
    // tool-call parts and capture the finish part's reason, then log on flush. Pass-through.
    wrapStream: async ({ doStream }) => {
      const { stream, ...rest } = await doStream();
      let finishReason = "?";
      let toolCalls = 0;
      const toolNames: string[] = [];
      let textLen = 0;
      let reasoningLen = 0;

      const tap = new TransformStream<LanguageModelV2StreamPart, LanguageModelV2StreamPart>({
        transform(part, controller) {
          try {
            const p = part as { type: string; delta?: string; text?: string; toolName?: string; finishReason?: unknown };
            if (p.type === "tool-call") {
              toolCalls += 1;
              if (p.toolName) toolNames.push(p.toolName);
            } else if (p.type === "text-delta") {
              textLen += (p.delta ?? p.text ?? "").length;
            } else if (p.type === "reasoning-delta") {
              reasoningLen += (p.delta ?? p.text ?? "").length;
            } else if (p.type === "finish") {
              // finishReason is usually a string ('stop'|'tool-calls'|…); some provider/middleware
              // shapes nest it. Coerce so the A-vs-C classifier (which keys off 'stop') still works.
              const fr = p.finishReason as unknown;
              finishReason = typeof fr === "string" ? fr : ((fr as { type?: string; finishReason?: string })?.finishReason ?? (fr as { type?: string })?.type ?? JSON.stringify(fr));
            }
          } catch {
            /* never let diagnostics break the stream */
          }
          controller.enqueue(part);
        },
        flush() {
          logStep(label, {
            finishReason,
            toolCalls,
            toolNames,
            hasText: textLen > 0,
            textLen,
            hasReasoning: reasoningLen > 0,
            reasoningLen,
          });
        },
      });

      return { stream: stream.pipeThrough(tap), ...rest };
    },
  };
}
