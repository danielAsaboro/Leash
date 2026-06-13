/**
 * Home Assistant tool group — control the user's smart-home devices over HA's LAN REST API.
 * The URL + long-lived token come from the encrypted secret vault (read PER CALL, so editing
 * them in Services takes effect with no restart). HA's API is on-device/LAN — no cloud.
 */
import { z } from "zod";
import { getSecret } from "../vault.ts";
import type { LeashSource } from "../sources.ts";
import { defineTool, type ToolGroup } from "./types.ts";

const HA_TIMEOUT_MS = Number(process.env["LEASH_HA_TIMEOUT_MS"] ?? 5000);
const HA_DOMAINS = ["light", "switch", "fan", "cover", "input_boolean", "scene"] as const;
const HA_LIST_CAP = 60;

interface HaState {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
}

type HaResult = { ok: false; status?: number; text: string } | { ok: true; status: number; data: unknown };

/** Single auth + timeout point for every HA REST call — turns every failure into honest text. */
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

const NO_SOURCES: LeashSource[] = [];

export const homeAssistantGroup: ToolGroup = {
  id: "home-assistant",
  label: "Home Assistant",
  description: "Control the user's smart-home devices (lights, switches, fans, covers, scenes) over Home Assistant's LAN REST API.",
  tools: [
    defineTool({
      name: "ha_list_entities",
      description:
        "List the user's Home Assistant devices/entities you can control (lights, switches, fans, covers, scenes, input booleans). Use to discover what's available before acting, or to answer 'what lights/devices do I have?'. Optionally narrow to one domain.",
      inputSchema: {
        domain: z.enum(HA_DOMAINS).optional().describe("Optional: only entities in this domain (e.g. 'light', 'switch')."),
      },
      handler: async ({ domain }) => {
        const r = await haFetch("/api/states");
        if (!r.ok) return { text: r.text, sources: NO_SOURCES };
        const states = (r.data as HaState[]) ?? [];
        const domains: readonly string[] = domain ? [domain] : HA_DOMAINS;
        const filtered = states.filter((s) => domains.includes(s.entity_id.split(".")[0] ?? ""));
        if (filtered.length === 0) {
          return { text: domain ? `No Home Assistant entities in domain "${domain}".` : "No controllable Home Assistant entities found.", sources: NO_SOURCES };
        }
        const shown = filtered.slice(0, HA_LIST_CAP);
        const lines = shown.map((s) => `${s.entity_id} — ${(s.attributes?.["friendly_name"] as string) ?? s.entity_id} — ${s.state}`);
        const more = filtered.length > HA_LIST_CAP ? `\n…and ${filtered.length - HA_LIST_CAP} more (narrow with domain).` : "";
        return { text: lines.join("\n") + more, sources: NO_SOURCES };
      },
    }),

    defineTool({
      name: "ha_get_state",
      description:
        "Get the current state and attributes of one Home Assistant entity (e.g. is the office light on, what's the thermostat set to). Pass the full entity_id (e.g. 'light.office'); use ha_list_entities first if unsure of the id.",
      inputSchema: {
        entity_id: z.string().describe("Full Home Assistant entity id, e.g. 'light.office' or 'switch.kettle'."),
      },
      handler: async ({ entity_id }) => {
        const r = await haFetch(`/api/states/${encodeURIComponent(entity_id)}`);
        if (!r.ok) return { text: r.status === 404 ? `No Home Assistant entity named "${entity_id}".` : r.text, sources: NO_SOURCES };
        const s = r.data as HaState;
        const name = (s.attributes?.["friendly_name"] as string) ?? s.entity_id;
        const attrs = Object.entries(s.attributes ?? {})
          .filter(([k]) => k !== "friendly_name")
          .slice(0, 8)
          .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
        return { text: `${s.entity_id} (${name})\nstate: ${s.state}` + (attrs.length ? `\n${attrs.join("\n")}` : ""), sources: NO_SOURCES };
      },
    }),

    defineTool({
      name: "ha_call_service",
      needsApproval: true,
      description:
        "Control a Home Assistant device by calling a service (e.g. turn on the office light = domain 'light', service 'turn_on', entity_id 'light.office'). Common services: turn_on, turn_off, toggle (light/switch/fan/input_boolean), open_cover/close_cover (cover), turn_on (scene). Confirm the entity_id with ha_list_entities if the device is ambiguous.",
      inputSchema: {
        domain: z.enum(HA_DOMAINS).describe("Service domain, must match the entity's domain (e.g. 'light')."),
        service: z.string().describe("Service to call, e.g. 'turn_on', 'turn_off', 'toggle'."),
        entity_id: z.string().describe("Target entity id, e.g. 'light.office'."),
        data: z.record(z.string(), z.any()).optional().describe("Optional extra service data, e.g. { brightness_pct: 50 }."),
      },
      handler: async ({ domain, service, entity_id, data }) => {
        const r = await haFetch(`/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`, {
          method: "POST",
          body: JSON.stringify({ entity_id, ...(data ?? {}) }),
        });
        if (!r.ok) return { text: r.text, sources: NO_SOURCES };
        const changed = (r.data as HaState[]) ?? [];
        const target = changed.find((s) => s.entity_id === entity_id);
        if (target) return { text: `${entity_id} is now ${target.state}.`, sources: NO_SOURCES };
        if (changed.length === 0) return { text: `Called ${domain}.${service} on ${entity_id} (no state change — may already be in that state).`, sources: NO_SOURCES };
        return { text: `Called ${domain}.${service}; changed: ${changed.map((s) => `${s.entity_id}=${s.state}`).join(", ")}.`, sources: NO_SOURCES };
      },
    }),
  ],
};
