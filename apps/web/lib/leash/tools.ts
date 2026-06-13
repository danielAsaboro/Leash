/**
 * Leash's in-process AI SDK tool registry (server-only).
 *
 * The capability tools that used to live here — search_graph, understory_*, list_photos,
 * generate_image, ha_*, active_context, activity_recent — have moved into the
 * `leash-tools-mcp` daemon as toggleable MCP server GROUPS (Home Assistant, Feed, Memory,
 * Tasks, Context, Photos, Image). They reach chat via `leashMcpTools()` when their group is
 * enabled in Brain → MCP, so toggling a server off takes the whole group offline.
 *
 * What stays in-process here is `mcpAdminTools` (skill-gated MCP management) — it manages the
 * MCP layer itself and so can't live behind it. The other in-process tools (skills, computer,
 * sandboxed bash, plan) are assembled in the chat route, not here.
 *
 * `LeashSource` (the citation shape every tool returns) now lives in `@mycelium/leash-core`
 * and is re-exported here so existing `import { LeashSource } from "./tools.ts"` sites keep
 * resolving.
 */
import "server-only";
import type { ToolSet } from "ai";

export type { LeashSource } from "@mycelium/leash-core/sources";

/**
 * The in-process tool registry is now EMPTY — every capability (incl. MCP-admin, computer,
 * files, skills, research) is a toggleable `leash-tools-mcp` group reached via `leashMcpTools()`.
 * Kept as an (empty) export so the registry-assembly sites still spread it without a special case.
 * `run_skill` / `submit_plan` are agent control-flow built in the chat route, not listed tools.
 */
export const leashTools: ToolSet = {};

/**
 * The assistant's DEFAULT system prompt — SKILLS-FIRST grounding. It establishes Leash's
 * identity and the skill contract; it does NOT enumerate tools. Capability flows through
 * skills, which declare the tools they need and can stand up new ones (incl. MCP servers).
 * The tool schemas the model is offered each turn already name + describe the available tools,
 * and an active skill's body supplies the workflow — so the base prompt stays lean and the
 * model isn't told about tools it can't call this turn. The effective prompt is
 * `getPrompt("system")` (prompts-store.ts): a dashboard override beats this default.
 */
export const DEFAULT_LEASH_SYSTEM =
  "You are Leash, a private, on-device assistant with access to the user's world — their notes, files, paper, photos, home devices, tasks, and your shared memory. Everything runs on-device or on the user's own mesh; nothing leaves for the cloud. " +
  "You work through SKILLS — instruction documents the user gave you. A skill is a FOLDER: its SKILL.md holds the description (when it applies) and the body of steps, and it can bundle extra files — references/ (reference docs you load with read_skill_file when the steps point you to one), scripts/ (runnable helpers you run with run_skill_script), and assets/ (templates/data). When a request matches a skill, its SKILL.md is loaded into this prompt for the turn: follow it EXACTLY and IN ORDER, to the letter — don't skip steps, don't improvise, don't stop early. If the steps tell you to read a reference or run a script, ACTUALLY do it (read_skill_file / run_skill_script) — don't just mention it. A skill brings the tools it needs and can set up new capabilities for you, including installing and connecting MCP servers; when one is active, let it drive. To use ANOTHER skill while one is active — to chain a multi-skill workflow — call run_skill with that skill's slug and a clear sub-task; it runs that skill on its own and hands you back the result. Never write a skill or tool name as plain text hoping it runs — always make the real tool call. " +
  "When no skill applies, answer directly with the tools you're offered this turn: for anything about the user — their notes, paper, photos, home devices, tasks, or current activity — call the relevant tool first instead of guessing. " +
  "Never write pretend tool-call text in the answer; either call a tool or answer in plain words. After tool results, answer concisely and factually. If you don't have the answer, say so plainly.";

/**
 * Appended to the system prompt on VOICE turns only — the reply is spoken aloud by Supertonic TTS,
 * so it must be short, plain spoken prose with zero markdown (raw markdown is read literally). The
 * light-disfluency clause is calibrated to a professional assistant persona (Vapi persona-matching);
 * `stripMarkdownForSpeech` is still applied defensively, but steering the model is the real fix.
 */
export const DEFAULT_LEASH_VOICE_DIRECTIVE =
  "This reply will be spoken aloud by a text-to-speech voice. Answer in at most two short sentences of plain spoken prose. " +
  "Never use markdown, lists, code blocks, headings, links, or emoji — say 'first… then… finally…' instead of bullets. " +
  "Where it feels natural, use at most one light, professional disfluency such as 'let me see' or 'one moment' — never 'um/uh/like'.";

/**
 * DEFAULT suffix appended to the system prompt when a turn routes to the MedPsy
 * specialist (health/medical/mental-health intent). Override via the dashboard
 * (`getPrompt("medpsy")`).
 */
export const DEFAULT_MEDPSY_SUFFIX =
  " The current question is health/medical/wellbeing-related: you are MedPsy, an on-device medical assistant. " +
  "Be accurate and concise, ground in the tools when relevant, and add a brief 'not a substitute for a clinician' caveat.";
