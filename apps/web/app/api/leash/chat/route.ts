/**
 * `POST /api/leash/chat` — the Leash assistant (Vercel AI SDK), with persistence.
 *
 * The client sends only the **last** message + the chat `id` + a `trigger`
 * (`prepareSendMessagesRequest`), so we rebuild history from the store:
 *   · submit-user-message      → append the new user message
 *   · regenerate-assistant-message → drop the target assistant message, re-run
 * We validate the stored+new messages against current tool/metadata schemas, stream the
 * on-device tool loop, persist the full thread in `onFinish`, and `consumeStream()` so a
 * client disconnect still saves. Server-side message IDs keep stored threads stable —
 * which the future "dreaming"/consolidation pass relies on.
 */
import { convertToModelMessages, validateUIMessages, createIdGenerator, createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { z } from "zod";
import { CHAT_MODEL, MEDPSY_MODEL, VISION_MODEL, COMPUTER_MODEL } from "../../../../lib/leash/provider.ts";
import { buildLeashAgent, type LeashCallOptions } from "../../../../lib/leash/agent.ts";
import { leashTools } from "../../../../lib/leash/tools.ts";
import { taskTools } from "../../../../lib/leash/task-tools.ts";
import { memoryTools } from "../../../../lib/leash/memory-tools.ts";
import { preferenceTexts } from "../../../../lib/leash/memories-store.ts";
import { skillTools, skillsSystemSection, activeSkillsSection } from "../../../../lib/leash/skill-tools.ts";
import { researchTools } from "../../../../lib/leash/research-tools.ts";
import { computerTools } from "../../../../lib/leash/computer-tools.ts";
import { buildBashTools, BASH_TOOL_NAMES } from "../../../../lib/leash/bash-tools.ts";
import { buildSkillRunner, runSkillAsPipeline } from "../../../../lib/leash/skill-runner.ts";
import { buildPlanTool, planDataSchema } from "../../../../lib/leash/plan-tools.ts";
import { leashMcpTools } from "../../../../lib/leash/mcp.ts";
import { getPrompt } from "../../../../lib/leash/prompts-store.ts";
import { filterEnabledTools, disabledTools, withApprovalGates } from "../../../../lib/leash/tool-config.ts";
import { loadRecord, saveChat } from "../../../../lib/leash/chat-store.ts";
import { compact } from "../../../../lib/leash/compactor.ts";
import { classifyEffort, effortConfig } from "../../../../lib/leash/effort.ts";
import { beginGeneration } from "../../../../lib/leash/inflight.ts";
import { subscribeElicitations } from "../../../../lib/leash/elicitations.ts";
import { interjectRequested, clearInterject } from "../../../../lib/leash/interject-store.ts";
import type { LeashUIMessage } from "../../../../lib/leash/types.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A deterministic step-pipeline turn runs several sequential model calls (one per step), so a turn can
// run a few minutes; keep the ceiling generous (local dev doesn't hard-enforce, but be honest about it).
export const maxDuration = 300;

// `.optional()` on the OBJECT: user messages carry no metadata at all (only assistant messages get
// it via `messageMetadata`), so the schema must accept `undefined` or validation fails on every
// stored thread and falls back to raw history.
const metadataSchema = z
  .object({
    createdAt: z.number().optional(),
    finishedAt: z.number().optional(),
    model: z.string().optional(),
    totalTokens: z.number().optional(),
    effort: z.enum(["quick", "standard", "deep"]).optional(),
  })
  .optional();

const skillDataSchema = z.object({
  mode: z.enum(["explicit", "automatic"]),
  skills: z.array(z.object({ slug: z.string(), name: z.string() })).min(1),
});

/**
 * Empty-turn guard (SmallCode quality-monitor port): an honest message to append when the model
 * finishes a turn with no answer text. If it ran tools, name them; else nudge to rephrase. Loosely
 * typed + fully defensive — this runs in the stream's tail and must never throw.
 */
async function emptyTurnFallback(result: unknown): Promise<string> {
  let toolNames: string[] = [];
  try {
    const steps = ((await (result as { steps?: Promise<unknown[]> }).steps) ?? []) as Array<{ toolCalls?: Array<{ toolName?: string }> }>;
    toolNames = [...new Set(steps.flatMap((s) => (s.toolCalls ?? []).map((c) => c.toolName).filter((n): n is string => !!n)))];
  } catch {
    /* fall through to the generic message */
  }
  return toolNames.length > 0
    ? `I ran ${toolNames.join(", ")} but didn't write up an answer. Ask me to continue, or rephrase if you'd like a summary.`
    : "I couldn't produce a response to that — try rephrasing it, or breaking it into smaller steps.";
}

/**
 * Forgiving-parser DETECTOR (SmallCode port, measure-and-nudge scope): did the model emit a tool
 * call as plain TEXT (`<tool_call>…</tool_call>`, Liquid `<|tool_call_start|>`, `functions.x(...)`,
 * or a bare `{"name":…,"arguments":…}`) instead of actually invoking it? We can't re-run it inside
 * a streamed turn, so we log it (to gauge how often this still happens now that compound tools
 * exist — the data that decides whether the full streaming-recovery middleware is worth the risk)
 * and the route adds an honest nudge. Returns the tool name when identifiable.
 */
function toolCallAsText(text: string): { matched: boolean; toolName?: string } {
  const tagged = /<tool_call>[\s\S]*?<\/tool_call>/i.test(text) || /<\|tool_call_start\|>/i.test(text);
  const fnStyle = /(?:^|[\s`])functions?\.[a-z_][a-z0-9_]*\s*\(/i.test(text);
  const bareJson = /\{\s*"name"\s*:\s*"[a-z0-9_]+"\s*,\s*"(?:arguments|parameters|input)"\s*:/i.test(text);
  if (!tagged && !fnStyle && !bareJson) return { matched: false };
  const m = text.match(/"name"\s*:\s*"([a-z0-9_]+)"/i) ?? text.match(/functions?\.([a-z0-9_]+)/i) ?? text.match(/<tool_call>\s*([a-z0-9_]+)/i);
  return { matched: true, toolName: m?.[1] };
}

/** The text-parts join of the most recent user message (intent classifiers + effort grading). */
function lastUserText(messages: LeashUIMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((lastUser?.parts as any[]) ?? []).filter((p) => p?.type === "text").map((p) => p.text ?? "").join(" ");
}

/** P4 specialist routing: health/medical/mental-health intent → the MedPsy specialist. */
const HEALTH_RE =
  /\b(symptom|diagnos|treatment|medicat|dosage|dose|prescri|disease|illness|infection|fever|nausea|migraine|asthma|diabet|pneumonia|antibiotic|blood ?pressure|cholesterol|doctor|physician|clinic|therap|anxiet|depress|mental health|insomnia|panic|trauma|psych|wellbeing|well-being)\w*/i;
function isHealthIntent(messages: LeashUIMessage[]): boolean {
  return HEALTH_RE.test(lastUserText(messages));
}

/** Vision routing: the latest user message carries an image (file part) → use the VLM. */
function isImageTurn(messages: LeashUIMessage[]): boolean {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((lastUser?.parts as any[]) ?? []).some((p) => p?.type === "file" && typeof p.mediaType === "string" && p.mediaType.startsWith("image/"));
}

/**
 * Computer-use routing: screen/GUI/shell/file intent → the (possibly bigger, possibly
 * mesh-delegated) computer driver — a NO-OP while `LEASH_COMPUTER_MODEL` is unset
 * (COMPUTER_MODEL === CHAT_MODEL) apart from the raised step budget below.
 */
const COMPUTER_RE =
  /\b(screen ?shot\w*|screen|click\w*|double.?click\w*|type(?!\s+of)|typing|scroll\w*|cursor|mouse|keyboard|open (?:the |this )?app\w*|launch\w*|run (?:a |the |this )?command\w*|command.?line|terminal|shell|(?:read|write|edit|create|save) (?:a |the |that |this |my )?file\w*)\b|~\//i;
function isComputerIntent(messages: LeashUIMessage[]): boolean {
  return COMPUTER_RE.test(lastUserText(messages));
}

/**
 * Files routing: RETRIEVAL intent over the user's files/notes/code → the sandboxed `bash`
 * tools (`bash-tools.ts`) preferred over the real-disk read tools. Matches a retrieval verb
 * near a file-ish noun, a bare `grep`/`glob`, or "in my files/notes/…". Checked BEFORE the
 * computer route so "search/read my notes" gets the safe sandbox, while "edit/create/save a
 * file", "run command", "terminal", and GUI verbs still fall through to the computer route.
 */
const FILES_RE =
  /\b(?:grep|ripgrep|\brg\b|glob)\b|\b(?:search|find|look(?:ing)?|list|show|read|cat|explore|scan|locate|count|summari[sz]e)\b[\s\S]{0,30}\b(?:files?|notes?|docs?|documents?|folders?|director(?:y|ies)|code(?:base)?|repo(?:sitor(?:y|ies)|s)?|projects?|workspace|markdown|\.(?:md|txt|json|csv|ya?ml))\b|\bin (?:my|the|this) (?:files?|notes?|docs?|code(?:base)?|folder|director(?:y|ies)|projects?|repo(?:sitor(?:y|ies)|s)?|workspace)\b/i;
function isFilesIntent(messages: LeashUIMessage[]): boolean {
  return FILES_RE.test(lastUserText(messages));
}

/** Step budget for computer-use turns — a GUI loop is screenshot → act → screenshot → verify. */
const COMPUTER_STEPS = 10;
/** Step budget for files turns — a retrieval loop is grep → read → grep → answer. */
const FILES_STEPS = 8;
/**
 * Step budget for a turn an ACTIVE skill drives with its own toolset (skillTools). Skill
 * workflows chain many tool calls (e.g. MCP install: inspect → clone/build → patch →
 * register), so they get the most headroom regardless of the effort tier.
 */
const SKILL_TOOL_STEPS = 12;
/** Plan-mode agent budget: submit_plan call (pauses for approval) → execute → present the result. */
const PLAN_STEPS = 4;

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as { id: string; trigger?: string; messageId?: string; message?: LeashUIMessage; voice?: boolean; plan?: boolean };
  const { id, trigger, messageId, message, voice, plan } = body;

  // A fresh turn STARTS here: clear any interject flag so a follow-up that ended the PREVIOUS turn
  // doesn't immediately end this one (this turn IS that follow-up).
  clearInterject(id);

  // Task/memory tools are per-request factories: writes get stamped with this chat's id.
  // This is the FULL registry — used for message validation; `streamText` gets the filtered set.
  const baseTools = { ...leashTools, ...taskTools(id), ...memoryTools(id), ...skillTools, ...researchTools, ...computerTools, ...(await buildBashTools()), ...(await leashMcpTools()) };
  // Plan mode (`submit_plan`): built unconditionally so stored plan-mode threads validate on any
  // turn; only handed to the AGENT when this turn is in plan mode (below). `getTask`/`getWriter` are
  // getters because the tool is built before the task text + response writer exist; `execute` (which
  // uses them) runs only after approval, by which point both are set.
  const planId = createIdGenerator({ prefix: "plan", size: 16 })();
  const planStream: { writer?: { write: (part: unknown) => void } } = {};
  let planTask = "";
  // The plan pipeline halts BETWEEN steps when the client stopped (`req.signal`) OR a follow-up is
  // waiting to interject — never by aborting a decode (that wedges the qvac loop); it only gates
  // whether the NEXT step launches.
  const planTool = buildPlanTool({ registry: baseTools, getTask: () => planTask, getWriter: () => planStream.writer, getAbort: () => req.signal.aborted || interjectRequested(id), planId });
  // `run_skill` delegates a sub-task to another skill as a sub-agent (multi-skill orchestration —
  // see skill-runner.ts). It delegates FROM the base registry (no nesting on itself).
  const tools = { ...baseTools, ...buildSkillRunner(baseTools), ...planTool };

  // Rebuild the working history from the store + the incoming trigger.
  const record = await loadRecord(id);
  const previous = record?.messages ?? [];
  let messages: LeashUIMessage[];
  if (trigger === "regenerate-message" && messageId) {
    const idx = previous.findIndex((m) => m.id === messageId);
    messages = idx === -1 ? previous : previous.slice(0, idx); // drop the assistant msg → regenerate
  } else if (message) {
    // REPLACE-BY-ID, not append: a tool-approval response mutates the LAST ASSISTANT
    // message in place client-side and resends it under the SAME id — appending would
    // duplicate it in the stored thread. A normal user submit has a fresh id (i === -1)
    // and still appends.
    const i = previous.findIndex((m) => m.id === message.id);
    messages = i === -1 ? [...previous, message] : [...previous.slice(0, i), message, ...previous.slice(i + 1)];
  } else {
    messages = previous;
  }

  // Validate stored+new messages against current tool/metadata schemas; fall back to raw on drift.
  let validated: LeashUIMessage[] = messages;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    validated = (await validateUIMessages({
      messages,
      tools: tools as any,
      metadataSchema,
      dataSchemas: { skill: skillDataSchema, plan: planDataSchema },
    })) as LeashUIMessage[];
  } catch (err) {
    console.error("leash: UI message validation failed, using raw history:", err);
  }

  // Routing: image turn → vision VLM; else computer-use intent (while any computer tool is
  // enabled) → the computer driver; else medical/wellbeing → MedPsy specialist; else generalist.
  const off = await disabledTools();
  const imageTurn = isImageTurn(validated);
  const computerEnabled = Object.keys(computerTools).some((name) => !off.has(name));
  // Files (sandboxed retrieval) takes precedence over computer for read/search intents
  // ("prefer bash tool over ours"); real writes/GUI/shell still fall through to computer.
  const filesEnabled = [...BASH_TOOL_NAMES].some((name) => !off.has(name));
  const filesTurn = !imageTurn && filesEnabled && isFilesIntent(validated);
  const computerTurn = !imageTurn && !filesTurn && computerEnabled && isComputerIntent(validated);
  const health = !imageTurn && !filesTurn && !computerTurn && isHealthIntent(validated);
  const activeModel = imageTurn ? VISION_MODEL : computerTurn ? COMPUTER_MODEL : health ? MEDPSY_MODEL : CHAT_MODEL;

  // Plan mode (user toggle): the GENERALIST chat turn becomes plan-then-execute. The model's only
  // job is to call `submit_plan` (approval-gated → the Plan card); on approval its `execute` runs the
  // steps through the deterministic pipeline. Restricted to the plain chat turn — image/files/computer/
  // health carry their own specialized toolsets + prompts, and a skill `steps:` pipeline (below) is a
  // deterministic workflow already, so plan mode stands down for those.
  const planMode = !!plan && !imageTurn && !filesTurn && !computerTurn && !health;

  // Dynamic effort: grade each non-image turn (text + voice) into a tier and derive its params
  // (tools on/off, step cap, `/no_think`, token ceiling). A spoken turn must answer in seconds,
  // so voice always runs `/no_think`; text keeps full `<think>` reasoning on the `deep` tier.
  // Image turns are unchanged (the VLM handles one image-grounded turn, no tools/no /no_think).
  const tier = imageTurn ? null : await classifyEffort(lastUserText(validated));
  const cfg = tier ? effortConfig(tier, !!voice) : null;
  const useNoThink = !!cfg?.noThink;

  // Prompts come from the store (dashboard override ?? code default; mtime-cached reads),
  // plus the skills section ("" when no skills — honest empty state).
  const lastText = lastUserText(validated);
  planTask = lastText; // the overall task each approved plan step is executed against
  const [systemPrompt, skillsSection, activeSkills, prefs] = await Promise.all([getPrompt("system"), skillsSystemSection(), activeSkillsSection(lastText), preferenceTexts()]);
  const baseSystem = health ? systemPrompt + (await getPrompt("medpsy")) : systemPrompt;
  // Always advertise the skill catalog — even with a skill already active — so the model can
  // ORCHESTRATE: discover and load OTHER skills mid-flow with read_skill (multi-skill workflows).
  // When a skill is auto-active its body is already injected (activeSkills.section); the catalog
  // here lets the model reach the rest.
  const availableSkillsSection = skillsSection;
  // Progressive tool disclosure: an active skill's declared `tools:` become the EXACT
  // toolset for this turn (agent.ts honors `skillTools`, overriding the route default).
  const declaredSkillTools = activeSkills?.tools ?? [];
  // `preference` memories steer behavior on EVERY turn (other memory types are
  // retrieval-only via recall/search_graph). Bounded: newest 20.
  const prefSection = prefs.length ? "Saved user preferences — follow them: " + prefs.slice(0, 20).map((p) => `· ${p}`).join(" ") : "";

  // Tool toggles apply at streamText (not at validation): old threads must still
  // validate against the full registry even when a tool they used is now disabled.
  // Approval gates ("Ask first") read config at call time — a toggle applies next turn.
  // Approval gates + disabled-tool filtering apply to the registry the AGENT holds;
  // the per-turn FOCUSED TOOLSET (computer turns activate only the six computer tools —
  // 28 offered schemas overflow the serve's 4096-token prompt and hang the decode,
  // verified 2026-06-07) is `activeTools` in the agent's prepareCall (agent.ts).
  // Plan mode restricts the AGENT to just `submit_plan` (already approval-gated) so the 4B is forced
  // to plan first; the approved steps execute against the FULL registry inside the tool. Otherwise
  // the normal enabled/approval-gated toolset — with `submit_plan` EXCLUDED (it's in `tools` only so
  // stored plan-mode threads validate; offering it every turn would invite spurious plans + eat the
  // serve's 4096-token tool budget).
  const agentTools = Object.fromEntries(Object.entries(tools).filter(([n]) => n !== "submit_plan"));
  const enabledTools = planMode ? planTool : withApprovalGates(await filterEnabledTools(agentTools));
  // Tell the model about its computer-use powers only when they're actually active —
  // naming them every turn invites hallucinated <tool_call>s for absent tools.
  const computerNote = computerTurn
    ? "You can act on this Mac (all on-device or on the user's own paired mesh, never a cloud): screenshot (SEE the screen — use it before and after acting), " +
      "and the approval-gated run_command (the real-disk executor — read with `cat`, write with a heredoc, edit with `sed`/`patch`, plus installs/builds) and computer (mouse+keyboard). If the user denies an approval, do not retry it."
    : "";
  // Files turn: name the sandboxed retrieval tool so the model reaches for bash (grep/find/cat/jq)
  // over the user's files. It's a read-only in-memory snapshot — no approval, can't touch the disk.
  const filesNote = filesTurn
    ? "You're in file-retrieval mode. You have a SANDBOXED `bash` over a READ-ONLY in-memory snapshot of the user's files " +
      "(run grep/find/cat/jq/ls to locate and read context). Prefer it for searching and reading the user's files. " +
      "The sandbox cannot touch the real disk — writes affect only the sandbox, so don't promise to have changed real files here."
    : "";
  // The (possibly overridden) system prompt may still NAME disabled tools — tell the
  // model they're gone, or it text-hallucinates <tool_call> blocks for them.
  // (`off` was read above for the computer-turn routing.)
  const disabledNote = off.size > 0 ? `The following tools are DISABLED and unavailable right now — do not attempt to call them: ${[...off].join(", ")}.` : "";
  // Some tool calls pause on a human approval card. A DENIED call must not be retried —
  // acknowledge the refusal and move on (without this, small models loop the same call).
  const approvalNote =
    "Some tool calls require the user's approval before running. If the user denies a tool call, do NOT retry it — acknowledge that it was declined and continue without it.";
  // Thinking-budget cap (SmallCode port): on reasoning-ON turns (deep text), qwen3-4b can burn its
  // whole token budget on <think> and emit no answer. Steer it to reason briefly so the answer fits
  // (paired with the raised deep-tier token budget in effort.ts). Only when not /no_think and not vision.
  const thinkingNote =
    !useNoThink && !imageTurn
      ? "Keep your private <think> reasoning BRIEF and focused — a few short sentences, not an essay — then write your actual answer. The answer matters more than the reasoning; never let thinking use up your whole response."
      : "";
  // Plan mode: the model's ONE job is to draft a plan via submit_plan; the user approves it and the
  // harness runs each step. After the steps run, present their combined result as your final answer.
  const planNote = planMode
    ? "PLAN MODE IS ON. Do NOT answer the request directly. Your ONLY action now is to call `submit_plan` with an ordered list of ATOMIC steps (one self-contained sub-task each) that together accomplish the request — even a simple request becomes a 1-step plan. The user will review and approve it, then each step runs in order; after they finish you present the combined result as your answer."
    : "";
  // Inline citations (graceful): when grounding an answer in retrieved sources, the model MAY tag
  // facts with [1], [2], … numbered in the order it first used them — the UI turns valid markers into
  // source pills. Optional, so it never forces behavior on a turn with no sources.
  const citeNote =
    !imageTurn && !computerTurn
      ? "If you state a fact you got from a search result (your notes or the paper), you may cite it inline as [1], [2], … numbering the sources in the order you first use them. Only cite real retrieved sources; never invent citation numbers."
      : "";

  // Context compaction (text turns only): when the thread outgrows the model's window,
  // summarize the oldest messages into a stored running summary and send only
  // [summary + recent tail] to the model. The FULL history stays in `validated` →
  // `originalMessages` → saved/displayed; only the model's input shrinks. Image turns
  // are single-shot, so they skip this. Best-effort: failure falls back to full history.
  // Tracks qwen3-4b's `ctx_size` in qvac.config.base.json (32768 since 2026-06-12, qwen3-4b's
  // native window — the serve's own default is a tiny 1024; agent turns carry 2-4k of tool
  // schemas + system prompt before history even starts). Keep the two in sync.
  const CTX = Number(process.env["LEASH_CHAT_CTX"] ?? 32768);
  let modelMessages = validated;
  let summarySection = "";
  if (!imageTurn) {
    const c = await compact(id, validated, CTX, { summary: record?.summary, summarizedThrough: record?.summarizedThrough });
    if (c.tailFrom > 0 && c.tailFrom < validated.length) modelMessages = validated.slice(c.tailFrom);
    if (c.summary) summarySection = `Earlier in this conversation (summary of ${c.tailFrom} prior message${c.tailFrom === 1 ? "" : "s"}): ${c.summary}`;
  }

  // On voice turns (non-image), append the spoken-output directive so the model answers in short,
  // markdown-free prose — Supertonic reads raw markdown literally. Text and image turns are unchanged.
  const system = [baseSystem, summarySection, prefSection, activeSkills?.section ?? "", availableSkillsSection, computerNote, filesNote, disabledNote, approvalNote, thinkingNote, citeNote, planNote, voice && !imageTurn ? await getPrompt("voice") : "", useNoThink ? "/no_think" : ""]
    .filter(Boolean)
    .join(" ");

  // Count this generation as in-flight so the dashboard's serve stop/restart refuses
  // while the serve is decoding (aborting/killing mid-generation wedges the GPU).
  const release = beginGeneration();

  // DETERMINISTIC-WORKFLOW turn: when the matched skill declares an ordered `steps:` plan, DRIVE it as
  // a pipeline (skill-runner.ts) instead of a free-run agent loop — the harness owns the step order, so
  // the 4B does one atomic sub-task per step and can't drop a dependent step (verified 2026-06-12:
  // pipeline 3/3 vs free-run ~1/3 on a dependent chain). The pipeline uses the skill's own declared
  // tools (approval-gated ones are skipped, like run_skill). Text turns only; image turns never match here.
  const pipeline = !imageTurn && !planMode ? activeSkills?.pipeline ?? null : null;
  if (pipeline) {
    let unsubscribePipe: (() => void) | undefined;
    const pipeStream = createUIMessageStream<LeashUIMessage>({
      originalMessages: validated,
      generateId: createIdGenerator({ prefix: "msg", size: 16 }),
      execute: async ({ writer }) => {
        writer.write({ type: "message-metadata", messageMetadata: { createdAt: Date.now(), model: CHAT_MODEL, ...(tier ? { effort: tier } : {}) } });
        unsubscribePipe = subscribeElicitations((ev) => {
          try {
            writer.write({ type: "data-elicitation", data: ev, transient: true });
          } catch {
            /* stream already closed */
          }
        });
        writer.write({ type: "data-skill", data: { mode: activeSkills?.mode ?? "automatic", skills: activeSkills?.skills ?? [{ slug: pipeline.slug, name: pipeline.slug }] } });
        let text: string;
        try {
          const out = await runSkillAsPipeline(pipeline.slug, lastText, baseTools);
          text = out.text;
        } catch (e) {
          text = `The "${pipeline.slug}" workflow couldn't finish: ${e instanceof Error ? e.message : String(e)}`;
        } finally {
          release();
        }
        const tid = "pipeline-out";
        writer.write({ type: "text-start", id: tid });
        writer.write({ type: "text-delta", id: tid, delta: text });
        writer.write({ type: "text-end", id: tid });
        writer.write({ type: "message-metadata", messageMetadata: { finishedAt: Date.now() } });
      },
      onFinish: ({ messages: finalMessages }) => {
        unsubscribePipe?.();
        release(); // idempotent
        void saveChat({ chatId: id, messages: finalMessages as LeashUIMessage[] });
      },
    });
    return createUIMessageStreamResponse({ stream: pipeStream });
  }

  // NOTE on serve-side kvCache: the forked serve accepts a `kv_cache` body field (see
  // patches/@qvac+cli) and hypha's shim caches delegated sessions — but THIS route does
  // not send a key. Every text tier runs tools-ON (the TOOLLESS-HANG guard in effort.ts),
  // and custom-key kv reuse across tool-call turns is unverified SDK territory; a wrong
  // count-state silently corrupts answers. Hypha-only by design — see the README.
  // Qwen3 best practice: historical assistant output must NOT carry its `<think>` reasoning — it
  // bloats context and degrades performance. Strip reasoning parts from the MODEL input only; the
  // stored/displayed thread keeps them (originalMessages = `validated`).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const noReasoning = modelMessages.map((m: any) => (m.role === "assistant" && Array.isArray(m.parts) ? { ...m, parts: m.parts.filter((p: any) => p?.type !== "reasoning") } : m));
  const modelInput = await convertToModelMessages(noReasoning);

  // The Leash agent (ToolLoopAgent, agent.ts): typed call options carry this turn's
  // derived context; `prepareCall` maps them to model / activeTools / steps / tokens.
  // DELIBERATELY no per-call `abortSignal` — the qvac serve WEDGES its LLM decode loop
  // if the client disconnects mid-generation (verified 2026-06-05: one aborted request
  // → every later generation hangs at zero tokens until the serve restarts; upstream
  // SDK bug). So on a voice barge-in / stop, the abandoned generation runs to
  // completion server-side (bounded by the tier's maxOutputTokens) and the next turn
  // queues briefly behind it — slow beats dead. Messages are compacted for the model
  // (summary + recent tail); the full thread is still saved via `originalMessages`.
  const agent = buildLeashAgent(enabledTools, () => interjectRequested(id));
  const callOptions: LeashCallOptions = {
    route: imageTurn ? "vision" : filesTurn ? "files" : computerTurn ? "computer" : health ? "health" : "chat",
    // Vision turns are single-shot: no tool loop, no step cap, and NO token ceiling
    // (qwen3vl breaks on max_tokens — see computer-tools.ts). A skill-driven toolset gets
    // the most steps; else computer/files get their raised budgets, else the effort tier's.
    steps: imageTurn || !cfg ? null : planMode ? PLAN_STEPS : declaredSkillTools.length ? SKILL_TOOL_STEPS : filesTurn ? FILES_STEPS : computerTurn ? COMPUTER_STEPS : cfg.steps,
    maxOutputTokens: imageTurn || !cfg ? null : cfg.maxOutputTokens,
    ...(declaredSkillTools.length ? { skillTools: declaredSkillTools } : {}),
    // Thinking ON ⇒ Qwen3 thinking-mode sampling; /no_think ⇒ non-thinking sampling (agent.ts).
    thinking: !imageTurn && !useNoThink,
    system,
  };
  const result = await agent.stream({ messages: modelInput, options: callOptions });

  // Persist even if the client disconnects mid-stream (and keep the serve connection open until the
  // generation completes — see the no-abortSignal note above). `then(release, release)` is the one
  // signal that ALWAYS fires once the serve is done decoding (success, error, or abandoned client).
  void result.consumeStream().then(release, release);

  // Wrap the model stream so out-of-band MCP elicitation events (server→user forms, see
  // elicitations.ts) ride this same SSE response as TRANSIENT data parts — they reach
  // `useChat`'s onData but are never persisted into the message. Wedge invariants are
  // unchanged: same no-abortSignal streamText above, same consumeStream→release, and
  // `originalMessages` keeps the same message-id reuse as before.
  let unsubscribe: (() => void) | undefined;
  const stream = createUIMessageStream<LeashUIMessage>({
    originalMessages: validated,
    generateId: createIdGenerator({ prefix: "msg", size: 16 }),
    execute: async ({ writer }) => {
      // Plan-mode `submit_plan.execute` streams `data-plan` step status through this writer.
      planStream.writer = writer as unknown as { write: (part: unknown) => void };
      unsubscribe = subscribeElicitations((ev) => {
        try {
          writer.write({ type: "data-elicitation", data: ev, transient: true });
        } catch {
          /* stream already closed — the GET /elicitations fallback covers reloads */
        }
      });
      if (activeSkills?.skills.length) {
        writer.write({
          type: "data-skill",
          data: { mode: activeSkills.mode, skills: activeSkills.skills },
        });
      }
      writer.merge(
        result.toUIMessageStream({
          sendReasoning: true,
          messageMetadata: ({ part }) => {
            if (part.type === "start") return { createdAt: Date.now(), model: activeModel, ...(tier ? { effort: tier } : {}) };
            if (part.type === "finish") return { finishedAt: Date.now(), totalTokens: part.totalUsage?.totalTokens };
            return undefined;
          },
          onError: (error) => {
            release();
            return error instanceof Error ? error.message : String(error);
          },
        }),
      );
      // Stream-tail quality guards (SmallCode quality-monitor ports). Best-effort — a throw here
      // must never break the response.
      try {
        const finalText = ((await result.text) ?? "").trim();
        const appendText = (id: string, text: string): void => {
          writer.write({ type: "text-start", id });
          writer.write({ type: "text-delta", id, delta: text });
          writer.write({ type: "text-end", id });
        };
        if (!finalText) {
          // Empty turn: the model emitted no answer (often after burning its budget on <think>).
          appendText("empty-turn-fallback", await emptyTurnFallback(result));
        } else {
          // Tool-call-as-text: the model wrote a tool call into its answer instead of invoking it.
          // Log it (to measure frequency) and add an honest nudge after the stray text.
          const tc = toolCallAsText(finalText);
          if (tc.matched) {
            console.warn(`leash: model emitted a tool call as TEXT${tc.toolName ? ` (${tc.toolName})` : ""} — route=${callOptions.route}, len=${finalText.length}`);
            appendText("toolcall-text-note", "\n\n_(I wrote that as text instead of actually running the tool — ask me to try again and I'll invoke it for real.)_");
          }
        }
      } catch {
        /* never let the guard break the response */
      }
    },
    onFinish: ({ messages: finalMessages }) => {
      unsubscribe?.();
      release(); // idempotent belt-and-braces alongside consumeStream().finally
      void saveChat({ chatId: id, messages: finalMessages as LeashUIMessage[] });
    },
  });

  return createUIMessageStreamResponse({ stream });
}
