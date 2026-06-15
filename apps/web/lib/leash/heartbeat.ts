/**
 * The proactive heartbeat (server-only) — one autonomous, non-interactive agent turn.
 *
 * Each cycle reads the user's constitution (soul + goals + the heartbeat.md checklist) and their
 * recent screen activity, then runs the SAME `buildLeashAgent` the chat route uses, but with a
 * PROPOSE-ONLY toolset (read context + create_task) and a tight system prompt. Silence is the
 * default: when nothing genuinely warrants the user's attention the model replies `HEARTBEAT_OK`,
 * which we suppress. Otherwise its drained (non-streamed) reply is the proposal.
 *
 * Fired by the scheduler (mcp-cron, kind: "heartbeat") via POST /api/leash/heartbeat, or by a leash-watch
 * context-switch. Part 4 layers tier classification (auto/notify/ask) on `runHeartbeat`'s result;
 * Part 5 turns a non-suppressed proposal into a delivered notification.
 */
import "server-only";
import { buildLeashAgent, type LeashCallOptions } from "./agent.ts";
import { leashMcpTools } from "./mcp.ts";
import { filterEnabledTools } from "./tool-config.ts";
import { getConstitution } from "./constitution.ts";
import { readActivityRecords } from "./graph.ts";
import { classifyAction, maxSimilarity, stricterTier, hardFloor, type Tier } from "./classify.ts";
import { withinDailyBudget, seenRecently, recentTexts, getOverride, recordSurfaced, signature } from "./heartbeat-state.ts";
import { addNotification } from "./notifications-store.ts";

/** Read context + the one safe, reversible write (create_task). No outward/irreversible tools. */
const PROPOSE_ONLY = new Set(["search_graph", "recall", "understory_search", "understory_today", "list_tasks", "create_task"]);

/** Step budget for the heartbeat loop — enough to read context + decide, bounded for cost. */
const HEARTBEAT_STEPS = 4;
/** How many recent activity records to ground the check in. */
const ACTIVITY_WINDOW = 25;
/** The sentinel the model emits when nothing warrants attention (silence-by-default). */
export const HEARTBEAT_OK = "HEARTBEAT_OK";
/** Cosine above which a fresh proposal is treated as a duplicate of a recently surfaced one. */
const DEDUP_THRESHOLD = 0.92;
/** Only the most recent N surfaced proposals are embedded for the fuzzy dedup check (bounds cost). */
const DEDUP_WINDOW = 10;

export interface HeartbeatResult {
  ok: boolean;
  /** True when nothing surfaced — silent (OK sentinel, dedup, budget exhausted, or empty assessment). */
  suppressed: boolean;
  /** Why it was suppressed or surfaced (for the cron run log / debugging). */
  reason?: string;
  /** The model's proposal text when surfaced (else null). */
  proposal: string | null;
  /** The classified delivery tier when surfaced. */
  tier?: Tier;
  /** Cosine of proposal vs goals (relevance signal). */
  onGoal?: number;
  /** Id of the notification created for a surfaced proposal. */
  notificationId?: string;
  /** Populated on a failed turn (serve down, no model) — surfaced honestly into the cron run log. */
  error?: string;
}

/** Split a free-text proposal into a short title (first line/sentence) + the full body. */
function titleAndBody(proposal: string): { title: string; body: string } {
  const firstLine = proposal.split("\n").map((l) => l.trim()).find(Boolean) ?? proposal;
  const firstSentence = firstLine.split(/(?<=[.!?])\s/)[0] ?? firstLine;
  const title = (firstSentence.length <= 90 ? firstSentence : firstSentence.slice(0, 87) + "…").replace(/^[#*\->\s]+/, "");
  return { title: title || "Proactive nudge", body: proposal };
}

/**
 * Clean a raw proposal of small-model noise before it becomes a notification: strip `<tool_call>…`
 * blocks the model emitted as TEXT (weak models sometimes "call" HEARTBEAT_OK as a fake tool), and a
 * leading `HEARTBEAT_*` editorial label the model prefixed (HEARTBEAT_OK, HEARTBEAT_ADVISORY:, …) so
 * it doesn't become the notification title. What remains is the nudge (or empty, which isHeartbeatOk
 * then treats as silence).
 */
function cleanProposal(text: string): string {
  return text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "") // malformed tool-call-as-text
    .replace(/```[\s\S]*?```/g, (m) => (/heartbeat_ok|tool_call|"name"/i.test(m) ? "" : m)) // junk code fences
    .replace(/^\s*(?:\*\*)?heartbeat_[a-z]+(?:\*\*)?[\s.:!-]*$/im, "") // a standalone HEARTBEAT_* label line
    .replace(/^\s*(?:\*\*)?heartbeat[_ ][a-z]+\b(?:\*\*)?[\s.:!-]*/i, "") // a leading HEARTBEAT_* label before the nudge
    .trim();
}

/** A reply that IS the OK sentinel (or empty after cleaning) → suppress. Guarded so a real proposal
 *  that merely mentions the word survives. */
function isHeartbeatOk(text: string): boolean {
  const t = text.trim();
  if (!t) return true; // empty / cleaned-to-nothing → nothing to say
  return /^heartbeat_ok\b/i.test(t) && t.length <= 40;
}

function recentActivityText(records: { ts: string; app: string; window: string; summary: string }[], n: number): string {
  const recent = records.slice(-n);
  if (!recent.length) return "";
  return recent
    .map((r) => {
      let when = r.ts;
      try {
        when = new Date(r.ts).toLocaleString();
      } catch {
        /* keep raw ts */
      }
      return `· ${when} — ${r.app}${r.window ? " · " + r.window : ""}: ${r.summary}`;
    })
    .join("\n");
}

function buildSystem(soul: string, goals: string, checklist: string, activity: string): string {
  return [
    "You are the user's PROACTIVE HEARTBEAT — a quiet background check, not a chat. You run on a timer; the user did not just ask you anything.",
    soul.trim() ? `Who you're assisting (soul.md):\n${soul.trim()}` : "",
    goals.trim() ? `Their goals (goals.md) — judge everything against these:\n${goals.trim()}` : "",
    checklist.trim() ? `What to watch this cycle (heartbeat.md):\n${checklist.trim()}` : "",
    activity ? `Their recent screen activity (most recent last):\n${activity}` : "No recent activity is available this cycle.",
    "Decide whether anything RIGHT NOW genuinely deserves the user's attention, weighed against their goals and the checklist above.",
    `If nothing does, reply with EXACTLY: ${HEARTBEAT_OK} — and nothing else. Silence is the default; most cycles end this way.`,
    "If something does, propose ONE concise, helpful nudge: what you noticed, WHY it matters for their goals, and your suggestion. " +
      "Ground it in what they already have using search_graph / recall / understory_search, and use create_task only to capture a concrete follow-up. " +
      "Never invent activity you weren't shown. Be calm and sparing — over-nudging erodes trust.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export interface HeartbeatOptions {
  /** Per-day notification budget (from the schedule's heartbeat config). 0/undefined = unlimited. */
  maxPerDay?: number;
}

/**
 * Run one heartbeat turn. Never throws — a serve/model failure resolves to `{ ok: false, error }`
 * so the caller (cron) can log it honestly rather than crash the daemon.
 *
 * Pipeline: agent proposes → HEARTBEAT_OK suppression → daily-budget gate → dedup (exact sig + fuzzy
 * embedding) → classify into a tier (hard floor + small model) → apply any "always do this" override →
 * record the surfaced fingerprint. The caller turns a non-suppressed result into a notification (Part 5).
 */
export async function runHeartbeat(opts: HeartbeatOptions = {}): Promise<HeartbeatResult> {
  const [{ soul, goals, heartbeat }, records] = await Promise.all([getConstitution(), readActivityRecords()]);
  const activity = recentActivityText(records, ACTIVITY_WINDOW);
  const system = buildSystem(soul, goals, heartbeat, activity);

  // Propose-only toolset over the live, user-toggle-respecting registry. No approval gates: the
  // heartbeat is non-interactive, so an "ask-first" tool would hang waiting on a user that isn't there.
  const live = await filterEnabledTools(await leashMcpTools());
  const tools = Object.fromEntries(Object.entries(live).filter(([name]) => PROPOSE_ONLY.has(name)));

  // The propose-only tools come from the always-up leash-tools-mcp daemon (reconcile auto-starts it).
  // If none are available yet — a fresh boot where the daemon is still warming — DEFER rather than run
  // a toolless turn: the tools:true/dynamic serve hangs at zero tokens on a no-tool request. The next
  // cycle, once the daemon is up, runs normally.
  if (Object.keys(tools).length === 0) {
    return { ok: false, suppressed: true, proposal: null, reason: "propose-only tools not ready (mcp daemon warming) — deferred" };
  }

  const agent = buildLeashAgent(tools);
  const options: LeashCallOptions = { route: "chat", steps: HEARTBEAT_STEPS, maxOutputTokens: 1024, thinking: false, system };

  let proposal: string;
  try {
    const result = await agent.stream({ messages: [{ role: "user", content: "Run the heartbeat check now." }], options });
    const raw = ((await result.text) ?? "").trim();
    // OK / short-OK suppression runs on the RAW reply, BEFORE cosmetic cleaning — otherwise stripping a
    // leading HEARTBEAT_OK label would turn "HEARTBEAT_OK — all aligned" into a spurious nudge.
    if (isHeartbeatOk(raw)) return { ok: true, suppressed: true, reason: "HEARTBEAT_OK", proposal: null };
    proposal = cleanProposal(raw); // strip tool-call/label noise for the surfaced nudge
  } catch (err) {
    return { ok: false, suppressed: true, proposal: null, error: String(err) };
  }

  // Cleaned to nothing (e.g. the reply was only a malformed tool-call) → treat as silence.
  if (!proposal) return { ok: true, suppressed: true, reason: "empty after cleaning", proposal: null };

  // Budget: stop surfacing once today's allowance is spent (silence-by-default still observes).
  if (!(await withinDailyBudget(opts.maxPerDay))) return { ok: true, suppressed: true, reason: "daily budget reached", proposal: null };

  // Dedup: exact signature first (cheap), then fuzzy embedding over the recent window.
  if (await seenRecently(proposal)) return { ok: true, suppressed: true, reason: "duplicate (recent)", proposal: null };
  const priors = (await recentTexts()).slice(-DEDUP_WINDOW);
  if ((await maxSimilarity(proposal, priors)) >= DEDUP_THRESHOLD) return { ok: true, suppressed: true, reason: "duplicate (similar)", proposal: null };

  // Classify into a delivery tier; an "always do this" override wins but never drops below the hard floor.
  const { tier: classified, reason, onGoal } = await classifyAction({ proposal, goals });
  const override = await getOverride(proposal);
  const tier = override ? stricterTier(override, hardFloor(proposal)) : classified;
  const why = override ? `override:${override} (${reason})` : reason;

  await recordSurfaced(proposal);

  // Emit the notification (the "voice"): the feed entry is the source of truth. The OS toast is a
  // SECONDARY channel delivered by the desktop renderer (LeashRail polls the feed and fires the
  // preload bridge for new unread items) — the server process has no access to Electron. auto-tier
  // arrives pre-read (no badge ping) — see the store.
  const { title, body } = titleAndBody(proposal);
  const note = await addNotification({ tier, title, body, why, sig: signature(proposal) });

  return { ok: true, suppressed: false, reason: why, proposal, tier, onGoal, notificationId: note.id };
}
