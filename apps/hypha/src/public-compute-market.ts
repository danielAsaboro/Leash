import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import type { AuditLog } from "@mycelium/shared";
import {
  PUBLIC_COMPUTE_ADVERT_KIND,
  PUBLIC_COMPUTE_ADVERT_TTL_MS,
  parsePublicProviderAdvert,
  selectPublicProvider,
  type PublicComputeNeed,
  type PublicModelCapability,
  type PublicProviderAdvert,
  type PublicProviderSelection,
  type PublicMesh,
} from "@mycelium/mesh";
import { localAliases } from "./catalog.ts";
import { QVAC_CONFIG_FILE, LOCAL_SERVE_URL } from "./config.ts";
import { PublicComputeClient, PublicComputeServer } from "./public-compute-control.ts";

export interface PublicCellRef { cellId: string; label: string; mesh: PublicMesh }
export interface PublicComputeSettings {
  enabled: boolean; maxConcurrent: number; maxRequestBytes: number; maxOutputTokens: number;
  timeoutMs: number; minHeadroomMb: number; priceMicrosPerKiloToken: number; payee?: string;
}
export interface PublicProviderView {
  advert: PublicProviderAdvert; cellLabel: string; stale: false;
}
export interface PublicJobEvidence {
  jobId: string; providerId: string; transportKey: string; selectionReason: string;
  state: "selected" | "streaming" | "succeeded" | "failed" | "cancelled";
  selectedAt: number; completedAt?: number; stats?: Record<string, unknown>; error?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const asInt = (v: unknown, fallback: number, min: number, max: number): number => Number.isInteger(v) ? Math.max(min, Math.min(max, v as number)) : fallback;

export class PublicComputeMarket {
  private settings: PublicComputeSettings;
  private advertisedCapabilities: PublicModelCapability[] = [];
  private readonly jobs = new Map<string, PublicJobEvidence>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private heartbeatChain: Promise<void> = Promise.resolve();
  private lastAdvertAt = 0;
  constructor(
    private readonly deps: {
      cells: () => PublicCellRef[]; server: PublicComputeServer; client: PublicComputeClient; audit: AuditLog;
      settingsFile: string; displayName: string; defaults: PublicComputeSettings;
    },
  ) { this.settings = this.load(); }

  get config(): PublicComputeSettings { return { ...this.settings }; }
  get client(): PublicComputeClient { return this.deps.client; }
  recordJobEvidence(evidence: PublicJobEvidence): void {
    this.jobs.set(evidence.jobId, evidence);
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [id, job] of this.jobs) if ((job.completedAt ?? job.selectedAt) < cutoff) this.jobs.delete(id);
    while (this.jobs.size > 1_000) this.jobs.delete(this.jobs.keys().next().value as string);
  }
  jobEvidence(jobId: string): PublicJobEvidence | null { return this.jobs.get(jobId) ?? null; }
  validateJob(body: Record<string, unknown>): { ok: true; alias: string; contextTokens: number; outputLimit: number } | { ok: false; error: string } {
    const alias = typeof body["model"] === "string" ? body["model"] : "";
    const messages = body["messages"];
    if (!Array.isArray(messages) || messages.length < 1 || messages.length > 128) return { ok: false, error: "messages must contain 1..128 entries" };
    for (const message of messages) {
      if (!isObj(message) || !["system", "user", "assistant", "tool"].includes(String(message["role"] ?? ""))) return { ok: false, error: "invalid message role or shape" };
      const content = message["content"];
      if (typeof content !== "string" && !Array.isArray(content)) return { ok: false, error: "invalid message content" };
      if (Array.isArray(content) && (content.length > 64 || content.some((part) => !isObj(part) || typeof part["type"] !== "string"))) return { ok: false, error: "invalid multimodal message content" };
    }
    if (body["stream"] !== undefined && typeof body["stream"] !== "boolean") return { ok: false, error: "stream must be boolean" };
    for (const [key, min, max] of [["temperature", 0, 2], ["top_p", 0, 1], ["frequency_penalty", -2, 2], ["presence_penalty", -2, 2]] as const) {
      const value = body[key];
      if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)) return { ok: false, error: `${key} is out of range` };
    }
    if (body["max_tokens"] !== undefined && (!Number.isInteger(body["max_tokens"]) || (body["max_tokens"] as number) < 1)) return { ok: false, error: "max_tokens must be a positive integer" };
    const tools = body["tools"];
    if (tools !== undefined && (!Array.isArray(tools) || tools.length > 32)) return { ok: false, error: "tools must contain at most 32 entries" };
    if (Array.isArray(tools)) for (const tool of tools) {
      const fn = isObj(tool) && isObj(tool["function"]) ? tool["function"] : null;
      if (!isObj(tool) || tool["type"] !== "function" || !fn || typeof fn["name"] !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(fn["name"] as string) || !isObj(fn["parameters"])) return { ok: false, error: "invalid function tool schema" };
    }
    const contextTokens = Math.ceil(Buffer.byteLength(JSON.stringify({ messages: body["messages"], tools: body["tools"] })) / 4);
    const requiresTools = Array.isArray(body["tools"]) && body["tools"].length > 0;
    const cap = this.advertisedCapabilities.find((c) => c.alias === alias && (c.task === "chat" || c.task === "health" || c.task === "vision"));
    if (!cap) return { ok: false, error: `alias ${alias || "(missing)"} is not currently advertised` };
    if (contextTokens > cap.contextWindow) return { ok: false, error: `request context ${contextTokens} exceeds ${cap.contextWindow}` };
    if (requiresTools && !cap.tools) return { ok: false, error: `alias ${alias} does not support tools` };
    return { ok: true, alias, contextTokens, outputLimit: cap.maxOutputTokens };
  }
  start(): void {
    if (this.timer) return;
    void this.refreshAvailability();
    this.timer = setInterval(() => void this.refreshAvailability(), 10_000); this.timer.unref();
  }
  async close(): Promise<void> { if (this.timer) clearInterval(this.timer); this.timer = null; await this.heartbeatChain; }
  /** Publish load transitions in order so a completed job cannot leave a stale `accepting:false`
   * snapshot visible until the next periodic heartbeat. */
  refreshAvailability(): Promise<void> {
    const queued = this.heartbeatChain.then(() => this.heartbeat());
    this.heartbeatChain = queued.catch(() => undefined);
    return queued;
  }
  async update(patch: Partial<PublicComputeSettings>): Promise<PublicComputeSettings> {
    this.settings = {
      ...this.settings,
      ...(typeof patch.enabled === "boolean" ? { enabled: patch.enabled } : {}),
      maxConcurrent: asInt(patch.maxConcurrent, this.settings.maxConcurrent, 1, 16),
      maxRequestBytes: asInt(patch.maxRequestBytes, this.settings.maxRequestBytes, 1024, 64 * 1024 * 1024),
      maxOutputTokens: asInt(patch.maxOutputTokens, this.settings.maxOutputTokens, 1, 65_536),
      timeoutMs: asInt(patch.timeoutMs, this.settings.timeoutMs, 1_000, 600_000),
      minHeadroomMb: asInt(patch.minHeadroomMb, this.settings.minHeadroomMb, 0, 131_072),
      priceMicrosPerKiloToken: asInt(patch.priceMicrosPerKiloToken, this.settings.priceMicrosPerKiloToken, 0, 1_000_000_000),
      ...(typeof patch.payee === "string" && patch.payee.length <= 128 ? { payee: patch.payee } : {}),
    };
    writeFileSync(this.deps.settingsFile, JSON.stringify(this.settings, null, 2));
    this.deps.audit.record({ event: "delegation", extra: { role: "public-provider", phase: this.settings.enabled ? "opt-in" : "opt-out", settings: this.settings } });
    await this.refreshAvailability();
    return this.config;
  }

  /** Latest authenticated, unexpired advert from every author in every joined public cell. */
  async discover(): Promise<{ providers: PublicProviderView[]; invalid: Array<{ author: string; reason: string; detail: string }>; discoveryMs: number }> {
    const started = Date.now(), providers: PublicProviderView[] = [], invalid: Array<{ author: string; reason: string; detail: string }> = [];
    for (const cell of this.deps.cells()) {
      await cell.mesh.sync({ timeoutMs: 2_500, settleMs: 250 }).catch(() => 0);
      const messages = await cell.mesh.all();
      const latest = new Map<string, (typeof messages)[number]>();
      for (const message of messages) if (message.kind === PUBLIC_COMPUTE_ADVERT_KIND && (!latest.has(message.author) || message.seq > latest.get(message.author)!.seq)) latest.set(message.author, message);
      for (const message of latest.values()) {
        const parsed = parsePublicProviderAdvert(message.data, message.author);
        if (!parsed.ok) { invalid.push({ author: message.author, reason: parsed.reason, detail: parsed.detail }); continue; }
        if (parsed.advert.cellId !== cell.cellId) { invalid.push({ author: message.author, reason: "invalid_advert", detail: "advert cell id mismatch" }); continue; }
        providers.push({ advert: parsed.advert, cellLabel: cell.label, stale: false });
      }
    }
    return { providers, invalid, discoveryMs: Date.now() - started };
  }

  /** Discover, capability-filter, actively probe reachability, then deterministically rerank. */
  async select(need: PublicComputeNeed): Promise<PublicProviderSelection & { discoveryMs: number; probeMs: number }> {
    const discovered = await this.discover();
    const ownIds = this.deps.cells().map((c) => c.mesh.feedKey);
    const baseNeed: PublicComputeNeed = { ...need, requesterProviderIds: [...(need.requesterProviderIds ?? []), ...ownIds], requesterTransportKeys: [...(need.requesterTransportKeys ?? []), this.deps.client.requesterId, this.deps.server.transportKey] };
    const preliminary = selectPublicProvider(discovered.providers.map((p) => p.advert), baseNeed);
    const reachability: Record<string, number | false> = {};
    const probeStarted = Date.now();
    await Promise.all(preliminary.eligible.map(async ({ advert }) => { try { reachability[advert.transportKey] = await this.deps.client.probe(advert); } catch { reachability[advert.transportKey] = false; } }));
    const selection = selectPublicProvider(discovered.providers.map((p) => p.advert), { ...baseNeed, reachability });
    return { ...selection, discoveryMs: discovered.discoveryMs, probeMs: Date.now() - probeStarted };
  }

  private load(): PublicComputeSettings {
    if (!existsSync(this.deps.settingsFile)) return { ...this.deps.defaults };
    try { const raw = JSON.parse(readFileSync(this.deps.settingsFile, "utf8")) as Partial<PublicComputeSettings>; return { ...this.deps.defaults, ...raw, enabled: raw.enabled === true }; } catch { return { ...this.deps.defaults, enabled: false }; }
  }

  private async capabilities(): Promise<PublicModelCapability[]> {
    let live = new Set<string>();
    try {
      const res = await fetch(`${LOCAL_SERVE_URL}/v1/models`, { signal: AbortSignal.timeout(2_000) });
      if (!res.ok) return [];
      const body = await res.json() as { data?: Array<{ id?: string }> };
      live = new Set((body.data ?? []).flatMap((m) => typeof m.id === "string" ? [m.id] : []));
    } catch { return []; }
    let config: Record<string, unknown> = {};
    try { config = JSON.parse(readFileSync(QVAC_CONFIG_FILE, "utf8")) as Record<string, unknown>; } catch { return []; }
    const models = isObj(config["serve"]) && isObj(config["serve"]["models"]) ? config["serve"]["models"] as Record<string, unknown> : {};
    const out: PublicModelCapability[] = [];
    for (const alias of localAliases()) {
      if (!live.has(alias.alias)) continue;
      const row = isObj(models[alias.alias]) ? models[alias.alias] as Record<string, unknown> : {};
      const cfg = isObj(row["config"]) ? row["config"] as Record<string, unknown> : {};
      const task = alias.modelType === "vision" ? "vision" : alias.modelType === "embedding" ? "embedding" : alias.modelType === "stt" ? "speech_to_text" : alias.modelType === "tts" ? "text_to_speech" : alias.alias === "health" ? "health" : alias.modelType === "chat" ? "chat" : null;
      if (!task) continue;
      out.push({ task, alias: alias.alias, contextWindow: asInt(cfg["ctx_size"], 8192, 256, 1_048_576), tools: (task === "chat" || task === "health") && cfg["tools"] === true, maxOutputTokens: Math.min(this.settings.maxOutputTokens, asInt(cfg["ctx_size"], 8192, 256, 65_536)) });
    }
    return out;
  }

  private async heartbeat(): Promise<void> {
    if (!this.settings.enabled) return;
    const caps = await this.capabilities();
    this.advertisedCapabilities = caps;
    if (caps.length === 0) { this.deps.audit.record({ event: "delegation", extra: { role: "public-provider", phase: "advert-suppressed", reason: "no locally served QVAC capabilities" } }); return; }
    const now = Date.now(); this.lastAdvertAt = now;
    for (const cell of this.deps.cells()) {
      const advert: PublicProviderAdvert = {
        version: 1, kind: PUBLIC_COMPUTE_ADVERT_KIND, cellId: cell.cellId, providerId: cell.mesh.feedKey, transportKey: this.deps.server.transportKey,
        lanEndpoints: this.deps.server.lanEndpoints(),
        displayName: this.deps.displayName, issuedAt: now, expiresAt: now + PUBLIC_COMPUTE_ADVERT_TTL_MS, nonce: randomBytes(16).toString("hex"),
        availability: { accepting: this.deps.server.inflightCount < this.settings.maxConcurrent, inflight: this.deps.server.inflightCount, maxConcurrent: this.settings.maxConcurrent, queueDepth: 0 },
        resources: { ramTotalMb: Math.round(totalmem() / 1048576), ramFreeMb: Math.round(freemem() / 1048576), minHeadroomMb: this.settings.minHeadroomMb, maxRequestBytes: this.settings.maxRequestBytes },
        privacy: { accepts: "shareable-only", retainsPrompts: false }, pricing: { microsPerKiloToken: this.settings.priceMicrosPerKiloToken, ...(this.settings.payee ? { payee: this.settings.payee } : {}) }, capabilities: caps,
      };
      await cell.mesh.post(PUBLIC_COMPUTE_ADVERT_KIND, advert);
      this.deps.audit.record({ event: "delegation", extra: { role: "public-provider", phase: "heartbeat", providerId: advert.providerId, transportKey: advert.transportKey, cellId: cell.cellId, expiresAt: advert.expiresAt, aliases: caps.map((c) => c.alias), inflight: advert.availability.inflight, ramFreeMb: advert.resources.ramFreeMb } });
    }
  }
}
