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

// DEFAULT_LEASH_SYSTEM lives in leash-defaults.ts (no server-only guard) so that
// main-agent.ts and tsx test scripts can import it without triggering Next.js's
// server-only guard. Re-exported here for backward compatibility.
export { DEFAULT_LEASH_SYSTEM } from "./leash-defaults.ts";

/**
 * The in-process tool registry is now EMPTY — every capability (incl. MCP-admin, computer,
 * files, skills, research) is a toggleable `leash-tools-mcp` group reached via `leashMcpTools()`.
 * Kept as an (empty) export so the registry-assembly sites still spread it without a special case.
 * `run_skill` / `submit_plan` are agent control-flow built in the chat route, not listed tools.
 */
export const leashTools: ToolSet = {};

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
