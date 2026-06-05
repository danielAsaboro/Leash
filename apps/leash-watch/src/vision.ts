/**
 * Frame understanding — POST the captured frame to the on-device VLM (`qwen3vl` on the
 * local `qvac serve` OpenAI endpoint) and turn the reply into a one-line summary + tags.
 *
 * 100% on-device: the image never leaves the machine (local :11435). Each call is
 * audit-logged (event "completion", model "qwen3vl", ttft/duration) into the evidence
 * bundle. Tags are derived deterministically (app slug + salient words) — no 2nd model call.
 */
import { AuditLog, now } from "@mycelium/shared";
import { QVAC_OPENAI_URL, VISION_MODEL, VISION_TIMEOUT_MS, LOG_DIR } from "./config.ts";

const audit = new AuditLog("leash-watch", LOG_DIR);
const PROMPT = "Summarize what's on screen in one line; note the app and task.";

export interface VisionResult {
  summary: string;
  tags: string[];
}

/** Drop Qwen3's `<think>…</think>` reasoning so only the answer remains. */
function stripThink(s: string): string {
  return s
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\/?think>/gi, "")
    .trim();
}

/** Reject empty / punctuation-only summaries (a junk frame shouldn't pollute the trail). */
function isJunk(s: string): boolean {
  const t = s.trim();
  return t.length < 3 || !/[a-z0-9]/i.test(t);
}

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "with", "for", "is", "are", "this",
  "that", "screen", "app", "user", "showing", "shows", "displayed", "currently", "appears",
]);

/** Deterministic tags: an app slug + up to 4 salient (≥4-char, non-stopword) summary words. */
function deriveTags(app: string, summary: string): string[] {
  const slug = app
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const salient: string[] = [];
  for (const w of summary.toLowerCase().match(/[a-z]{4,}/g) ?? []) {
    if (STOP.has(w) || salient.includes(w)) continue;
    salient.push(w);
    if (salient.length >= 4) break;
  }
  return [slug, ...salient].filter(Boolean);
}

interface ChatCompletion {
  choices?: { message?: { content?: string } }[];
  usage?: { completion_tokens?: number };
}

/**
 * The single in-flight VLM call. We never run two at once and NEVER abort one mid-decode:
 * disconnecting the qvac serve mid-generation wedges its decode loop machine-wide until a reboot
 * (verified 2026-06-05 — this watcher's old 60s AbortController was killing the serve whenever a
 * vision tick contended with a chat turn and ran long).
 */
let inFlight: Promise<unknown> | null = null;

/** The pending vision request, if any — shutdown awaits it so quitting never disconnects mid-decode. */
export function visionInFlight(): Promise<unknown> | null {
  return inFlight;
}

/**
 * Summarize one frame with the on-device VLM. Throws on transport error / junk reply.
 * Resilience is single-flight + SOFT timeout: if the reply takes longer than VISION_TIMEOUT_MS we
 * stop WAITING (this tick errors, the loop moves on) but the request keeps running to completion in
 * the background — and ticks are skipped until it settles, so requests never stack on a busy serve.
 */
export async function summarizeFrame(dataUrl: string, app: string): Promise<VisionResult> {
  if (inFlight) throw new Error("previous vision request still in flight — tick skipped (never abort mid-decode)");
  const t0 = now();
  const request = (async (): Promise<VisionResult> => {
    const res = await fetch(`${QVAC_OPENAI_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: PROMPT },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
    });
    const ttftMs = now() - t0; // no streaming here: time to the (single) response
    if (!res.ok) {
      void res.text().catch(() => {}); // drain the error body — leave the connection clean
      throw new Error(`vision endpoint returned ${res.status}`);
    }
    const json = (await res.json()) as ChatCompletion;
    const summary = stripThink(json.choices?.[0]?.message?.content ?? "");
    if (isJunk(summary)) throw new Error("empty/junk vision summary");
    const durationMs = now() - t0;
    audit.record({
      event: "completion",
      modelId: VISION_MODEL,
      prompt: PROMPT,
      tokens: json.usage?.completion_tokens,
      ttftMs,
      durationMs,
      extra: { app, summary },
    });
    return { summary, tags: deriveTags(app, summary) };
  })();
  inFlight = request.finally(() => {
    inFlight = null;
  });
  inFlight.catch(() => {
    /* orphaned past the soft timeout — its outcome was already reported to the tick */
  });

  // Soft timeout: give up waiting, do NOT abort (no AbortController anywhere near this fetch).
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`vision reply >${VISION_TIMEOUT_MS / 1000}s — letting it finish in the background (tick skipped, NOT aborted)`)),
          VISION_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
