/**
 * Leash's AI SDK tool registry (server-only) — all real, no mocks.
 *
 *   search_graph      — the user's private notes + screen-activity trail (RAG over QVAC embeddings)
 *   understory_search — published articles in The Understory (the user's paper)
 *   understory_today  — the latest edition's headlines
 *   list_photos       — the user's images + on-device auto-tags
 *   generate_image    — on-device diffusion image generation
 *   ha_list_entities / ha_get_state / ha_call_service — Home Assistant control over its LAN REST API
 *   active_context / activity_recent — the on-device screen watcher's activity trail (apps/leash-watch)
 *
 * Each tool returns `{ text, sources }`: `text` is what the model reads to compose its
 * answer; `sources` is the structured citation list the UI renders (AI Elements Sources).
 * Home Assistant is reached directly over its LAN REST API (server-side, token never leaves
 * the Next process); the activity tools read the watcher's JSONL trail. Both auto-merge into
 * the chat call with zero route changes (further MCP servers still join via `mcp.ts`).
 */
import "server-only";
import { tool, experimental_generateImage as generateImage } from "ai";
import { z } from "zod";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma, Stage } from "@mycelium/db";
import { searchNotes, readActivityRecords } from "./graph.ts";
import { getSecret } from "./vault.ts";
import { imageModel, IMAGE_MODEL } from "./provider.ts";
import { mcpAdminTools } from "./mcp-admin-tools.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** apps/web/lib/leash → apps/web/public/leash-gen (Next serves /leash-gen/*). */
const GEN_DIR = join(here, "..", "..", "public", "leash-gen");
/** apps/web/lib/leash → repo root → data/leash-photo-tags.json (written by `npm run tag-photos`). */
const PHOTO_TAGS = process.env["LEASH_PHOTO_TAGS"] ?? join(here, "..", "..", "..", "..", "data", "leash-photo-tags.json");

// ── Home Assistant (P3) ──────────────────────────────────────────────────────
// HA's LAN REST API is reachable from the Next server, so we expose it directly as
// server-side tools (no daemon). The URL + long-lived token come from the encrypted
// secret vault (falling back to env for back-compat) and are read PER CALL, so editing
// them in /services takes effect with no restart. HA's own API is on-device/LAN.
const HA_TIMEOUT_MS = Number(process.env["LEASH_HA_TIMEOUT_MS"] ?? 5000);
const HA_DOMAINS = ["light", "switch", "fan", "cover", "input_boolean", "scene"] as const;
const HA_LIST_CAP = 60;

/** A Home Assistant entity state (the subset we read from `/api/states`). */
interface HaState {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
}

/** Tagged result of an HA call — never throws, so tools always return honest text. */
type HaResult = { ok: false; status?: number; text: string } | { ok: true; status: number; data: unknown };

/**
 * Single auth + timeout point for every HA REST call. Mirrors the speak/transcribe HTTP
 * pattern plus an AbortController timeout; turns every failure mode into honest text.
 */
async function haFetch(path: string, init?: RequestInit): Promise<HaResult> {
  const HA_URL = getSecret("LEASH_HA_URL").replace(/\/+$/, "");
  const HA_TOKEN = getSecret("LEASH_HA_TOKEN");
  if (!HA_URL || !HA_TOKEN) {
    return { ok: false, text: "Home Assistant is not configured (set its URL + token in Services → Connections)." };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HA_TIMEOUT_MS);
  try {
    const res = await fetch(`${HA_URL}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${HA_TOKEN}`, "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    if (!res.ok) {
      const hint = res.status === 401 ? " (check LEASH_HA_TOKEN)" : "";
      return { ok: false, status: res.status, text: `Home Assistant returned ${res.status}${hint}.` };
    }
    return { ok: true, status: res.status, data: await res.json() };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, text: `Home Assistant request timed out after ${HA_TIMEOUT_MS}ms.` };
    }
    return { ok: false, text: "Home Assistant is unreachable (check LEASH_HA_URL / that it is online)." };
  } finally {
    clearTimeout(timer);
  }
}

// ── Screen-watcher activity trail (P2) ─────────────────────────────────────────
// Activity reads go through graph.ts's `readActivityRecords`, which filters out
// tombstoned ("forgotten") records — see tombstones.ts.
import type { ActivityRecord } from "./graph.ts";

const readActivity = readActivityRecords;

/** "12m ago" / "just now" from an ISO timestamp. */
function agoLabel(ts: string): string {
  const then = new Date(ts).getTime();
  if (Number.isNaN(then)) return "recently";
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  return mins <= 0 ? "just now" : `${mins}m ago`;
}

/** Local HH:MM from an ISO timestamp (for timeline lines). */
function hhmm(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "--:--";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

interface PhotoTag {
  file: string;
  label: string;
  confidence: number;
  isDocument: boolean;
}

/** A citation surfaced to the UI. */
export interface LeashSource {
  kind: "graph" | "paper";
  title: string;
  snippet: string;
  /** In-app link for paper sources (`/<date>/<slug>`). */
  url?: string;
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

export const leashTools = {
  search_graph: tool({
    description:
      "Search the user's private context graph (their personal notes, files, voice memos, and past conversations with you) for passages relevant to a query. Call this whenever answering needs private facts about the user, their devices, projects, preferences, or what was said in an earlier chat — do not guess.",
    inputSchema: z.object({
      query: z.string().describe("Natural-language description of the information needed."),
      topK: z.number().int().min(1).max(8).optional().describe("How many snippets to retrieve (default 3)."),
    }),
    execute: async ({ query, topK }) => {
      const hits = await searchNotes(query, topK ?? 3);
      const sources: LeashSource[] = hits.map((h) => ({ kind: "graph", title: `Note · ${h.source}`, snippet: oneLine(h.text).slice(0, 200) }));
      return {
        text: hits.length ? hits.map((h) => `(${h.source}) ${oneLine(h.text)}`).join("\n---\n") : "No matching passages in the user's private notes.",
        sources,
      };
    },
  }),

  understory_search: tool({
    description:
      "Search The Understory — the user's auto-written, on-device daily paper — for PUBLISHED articles relevant to a query. Use for questions about what the paper has covered.",
    inputSchema: z.object({
      query: z.string().describe("What to look for across headlines, deks, and bodies."),
      topK: z.number().int().min(1).max(12).optional().describe("How many articles (default 5)."),
    }),
    execute: async ({ query, topK }) => {
      const q = query.trim();
      if (q.length < 2) return { text: "Provide a search query of at least 2 characters.", sources: [] as LeashSource[] };
      const rows = await prisma.article.findMany({
        where: { stage: Stage.PUBLISHED, OR: [{ headline: { contains: q } }, { dek: { contains: q } }, { body: { contains: q } }] },
        orderBy: [{ publishedAt: "desc" }],
        take: topK ?? 5,
        select: { date: true, slug: true, headline: true, dek: true },
      });
      const sources: LeashSource[] = rows.map((r) => ({ kind: "paper", title: r.headline, snippet: oneLine(r.dek), url: `/feed/${r.date}/${r.slug}` }));
      return {
        text: rows.length ? rows.map((r) => `(${r.date}) ${r.headline} — ${oneLine(r.dek)}`).join("\n") : `No published articles match "${q}".`,
        sources,
      };
    },
  }),

  understory_today: tool({
    description: "List the headlines published in the LATEST edition of The Understory. Use when asked what's in today's paper / today's news.",
    inputSchema: z.object({}),
    execute: async () => {
      const latest = await prisma.article.findFirst({ where: { stage: Stage.PUBLISHED }, orderBy: [{ date: "desc" }], select: { date: true } });
      if (!latest) return { text: "The Understory has no published editions yet.", sources: [] as LeashSource[] };
      const rows = await prisma.article.findMany({
        where: { stage: Stage.PUBLISHED, date: latest.date },
        orderBy: [{ publishedAt: "asc" }],
        select: { date: true, slug: true, headline: true, dek: true },
      });
      const sources: LeashSource[] = rows.map((r) => ({ kind: "paper", title: r.headline, snippet: oneLine(r.dek), url: `/feed/${r.date}/${r.slug}` }));
      return {
        text: `The Understory — latest edition (${latest.date}), ${rows.length} stories:\n` + rows.map((r) => `${r.headline} — ${oneLine(r.dek)}`).join("\n"),
        sources,
      };
    },
  }),

  list_photos: tool({
    description:
      "List the user's images and their on-device auto-tags (e.g. document, food, other). Use to answer what photos/images the user has, or to find images of a kind. Tags are produced by on-device classification (`npm run tag-photos`).",
    inputSchema: z.object({
      label: z.string().optional().describe("Optional: only images whose top tag matches this label (e.g. 'food', 'report', 'other')."),
    }),
    execute: async ({ label }) => {
      let tags: PhotoTag[] = [];
      try {
        tags = JSON.parse(await readFile(PHOTO_TAGS, "utf-8")) as PhotoTag[];
      } catch {
        return { text: "No images have been tagged yet. Run `npm run tag-photos` to classify images in data/photos.", sources: [] as LeashSource[] };
      }
      const want = label?.trim().toLowerCase();
      const filtered = want ? tags.filter((t) => t.label.toLowerCase() === want) : tags;
      if (filtered.length === 0) {
        return { text: want ? `No images tagged "${label}".` : "No tagged images found.", sources: [] as LeashSource[] };
      }
      const sources: LeashSource[] = filtered.map((t) => ({ kind: "graph", title: `Image · ${t.file}`, snippet: `${t.label} (${Math.round(t.confidence * 100)}%)${t.isDocument ? " · document" : ""}` }));
      return {
        text: filtered.map((t) => `${t.file} — ${t.label} (${Math.round(t.confidence * 100)}%)${t.isDocument ? ", document" : ""}`).join("\n"),
        sources,
      };
    },
  }),

  generate_image: tool({
    description:
      "Generate an image from a text description, fully on-device. Use when the user asks to draw, create, generate, paint, or visualize a picture/image. Write a vivid, detailed prompt.",
    inputSchema: z.object({
      prompt: z.string().describe("A detailed visual description of the image to generate."),
    }),
    execute: async ({ prompt }) => {
      try {
        const { image } = await generateImage({ model: imageModel(), prompt, size: "512x512" });
        await mkdir(GEN_DIR, { recursive: true });
        const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
        await writeFile(join(GEN_DIR, name), Buffer.from(image.uint8Array));
        // Return a small URL (not base64) so the message stream stays light; UI renders the file.
        return { url: `/leash-gen/${name}`, prompt, text: `Generated an image for: ${prompt}` };
      } catch (err) {
        // Don't throw a raw provider error at the UI — return an honest, actionable result
        // (the model relays `text`; the ImageCard renders `error`).
        const raw = err instanceof Error ? err.message : String(err);
        const offline = /fetch failed|ECONNREFUSED|failed to fetch|connect/i.test(raw);
        const missing = /model_not_found|not available|not loaded/i.test(raw);
        const text = offline
          ? "I couldn't generate the image — the on-device model service is offline. Start it with `npm run qvac`."
          : missing
            ? `I couldn't generate the image — the image model "${IMAGE_MODEL}" isn't loaded. Add it to qvac.config.base.json → serve.models and restart \`npm run qvac\`.`
            : `I couldn't generate the image: ${raw}`;
        return { error: text, prompt, text };
      }
    },
  }),

  ha_list_entities: tool({
    description:
      "List the user's Home Assistant devices/entities you can control (lights, switches, fans, covers, scenes, input booleans). Use to discover what's available before acting, or to answer 'what lights/devices do I have?'. Optionally narrow to one domain.",
    inputSchema: z.object({
      domain: z.enum(HA_DOMAINS).optional().describe("Optional: only entities in this domain (e.g. 'light', 'switch')."),
    }),
    execute: async ({ domain }) => {
      const r = await haFetch("/api/states");
      if (!r.ok) return { text: r.text, sources: [] as LeashSource[] };
      const states = (r.data as HaState[]) ?? [];
      const domains: readonly string[] = domain ? [domain] : HA_DOMAINS;
      const filtered = states.filter((s) => domains.includes(s.entity_id.split(".")[0] ?? ""));
      if (filtered.length === 0) {
        return { text: domain ? `No Home Assistant entities in domain "${domain}".` : "No controllable Home Assistant entities found.", sources: [] as LeashSource[] };
      }
      const shown = filtered.slice(0, HA_LIST_CAP);
      const lines = shown.map((s) => `${s.entity_id} — ${(s.attributes?.["friendly_name"] as string) ?? s.entity_id} — ${s.state}`);
      const more = filtered.length > HA_LIST_CAP ? `\n…and ${filtered.length - HA_LIST_CAP} more (narrow with domain).` : "";
      return { text: lines.join("\n") + more, sources: [] as LeashSource[] };
    },
  }),

  ha_get_state: tool({
    description:
      "Get the current state and attributes of one Home Assistant entity (e.g. is the office light on, what's the thermostat set to). Pass the full entity_id (e.g. 'light.office'); use ha_list_entities first if unsure of the id.",
    inputSchema: z.object({
      entity_id: z.string().describe("Full Home Assistant entity id, e.g. 'light.office' or 'switch.kettle'."),
    }),
    execute: async ({ entity_id }) => {
      const r = await haFetch(`/api/states/${encodeURIComponent(entity_id)}`);
      if (!r.ok) {
        return { text: r.status === 404 ? `No Home Assistant entity named "${entity_id}".` : r.text, sources: [] as LeashSource[] };
      }
      const s = r.data as HaState;
      const name = (s.attributes?.["friendly_name"] as string) ?? s.entity_id;
      const attrs = Object.entries(s.attributes ?? {})
        .filter(([k]) => k !== "friendly_name")
        .slice(0, 8)
        .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
      return {
        text: `${s.entity_id} (${name})\nstate: ${s.state}` + (attrs.length ? `\n${attrs.join("\n")}` : ""),
        sources: [] as LeashSource[],
      };
    },
  }),

  ha_call_service: tool({
    description:
      "Control a Home Assistant device by calling a service (e.g. turn on the office light = domain 'light', service 'turn_on', entity_id 'light.office'). Common services: turn_on, turn_off, toggle (light/switch/fan/input_boolean), open_cover/close_cover (cover), turn_on (scene). Confirm the entity_id with ha_list_entities if the device is ambiguous.",
    inputSchema: z.object({
      domain: z.enum(HA_DOMAINS).describe("Service domain, must match the entity's domain (e.g. 'light')."),
      service: z.string().describe("Service to call, e.g. 'turn_on', 'turn_off', 'toggle'."),
      entity_id: z.string().describe("Target entity id, e.g. 'light.office'."),
      data: z.record(z.string(), z.any()).optional().describe("Optional extra service data, e.g. { brightness_pct: 50 }."),
    }),
    execute: async ({ domain, service, entity_id, data }) => {
      const r = await haFetch(`/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`, {
        method: "POST",
        body: JSON.stringify({ entity_id, ...(data ?? {}) }),
      });
      if (!r.ok) return { text: r.text, sources: [] as LeashSource[] };
      const changed = (r.data as HaState[]) ?? [];
      const target = changed.find((s) => s.entity_id === entity_id);
      if (target) return { text: `${entity_id} is now ${target.state}.`, sources: [] as LeashSource[] };
      if (changed.length === 0) {
        return { text: `Called ${domain}.${service} on ${entity_id} (no state change — may already be in that state).`, sources: [] as LeashSource[] };
      }
      return { text: `Called ${domain}.${service}; changed: ${changed.map((s) => `${s.entity_id}=${s.state}`).join(", ")}.`, sources: [] as LeashSource[] };
    },
  }),

  active_context: tool({
    description:
      "What the user is doing on their screen RIGHT NOW, from the on-device screen watcher (`npm run watch`). Use for 'what am I doing?' / 'what's on my screen?'. Returns the most recent observed app, window, and a one-line summary.",
    inputSchema: z.object({}),
    execute: async () => {
      const records = await readActivity();
      if (records.length === 0) {
        return { text: "No screen activity recorded yet. Start the watcher with `npm run watch` (and grant Screen Recording).", sources: [] as LeashSource[] };
      }
      const r = records[records.length - 1] as ActivityRecord;
      const window = r.window ? ` (${r.window})` : "";
      const tags = Array.isArray(r.tags) && r.tags.length ? ` [${r.tags.join(", ")}]` : "";
      const text = `As of ${agoLabel(r.ts)} — ${r.app}${window}: ${r.summary}${tags}`;
      const sources: LeashSource[] = [{ kind: "graph", title: `Activity · ${r.app} ${hhmm(r.ts)}`, snippet: oneLine(r.summary).slice(0, 200) }];
      return { text, sources };
    },
  }),

  activity_recent: tool({
    description:
      "The user's screen activity over the last N minutes, from the on-device screen watcher. Use for 'what have I been working on?' / 'summarize the last 30 minutes'. Returns a timeline of observed apps and tasks.",
    inputSchema: z.object({
      minutes: z.number().int().min(1).max(1440).optional().describe("How far back to look, in minutes (default 30)."),
    }),
    execute: async ({ minutes }) => {
      const window = minutes ?? 30;
      const cutoff = Date.now() - window * 60000;
      const records = await readActivity();
      if (records.length === 0) {
        return { text: "No screen activity recorded yet. Start the watcher with `npm run watch` (and grant Screen Recording).", sources: [] as LeashSource[] };
      }
      const recent = records.filter((r) => new Date(r.ts).getTime() >= cutoff);
      if (recent.length === 0) {
        return { text: `No screen activity in the last ${window} minutes.`, sources: [] as LeashSource[] };
      }
      const lines = recent.map((r) => {
        const win = r.window ? ` — ${r.window}` : "";
        return `${hhmm(r.ts)} ${r.app}${win}: ${r.summary}`;
      });
      const sources: LeashSource[] = recent.slice(-5).map((r) => ({
        kind: "graph",
        title: `Activity · ${r.app} ${hhmm(r.ts)}`,
        snippet: oneLine(r.summary).slice(0, 200),
      }));
      return { text: `Activity in the last ${window} minutes (${recent.length} observations):\n${lines.join("\n")}`, sources };
    },
  }),

  ...mcpAdminTools,
};

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
