/** Public-compute advertisement validation and deterministic provider selection. */
export const PUBLIC_COMPUTE_ADVERT_KIND = "public-compute-provider-v1" as const;
export const PUBLIC_COMPUTE_ADVERT_TTL_MS = 30_000;

export type PublicComputeTask = "chat" | "health" | "vision" | "embedding" | "speech_to_text" | "text_to_speech";
export interface PublicModelCapability { task: PublicComputeTask; alias: string; contextWindow: number; tools: boolean; maxOutputTokens: number }
export interface PublicProviderAdvert {
  version: 1; kind: typeof PUBLIC_COMPUTE_ADVERT_KIND; cellId: string;
  /** Per-cell Hypercore author key. */ providerId: string;
  /** Noise public key of the dedicated public-compute transport. */ transportKey: string;
  /** Signed RFC1918/link-local connection hints. They are tried with the same pinned Noise key
   * before the DHT, so a warmed LAN keeps working when external bootstrap nodes are unavailable. */
  lanEndpoints: Array<{ host: string; port: number }>;
  displayName: string; issuedAt: number; expiresAt: number; nonce: string;
  availability: { accepting: boolean; inflight: number; maxConcurrent: number; queueDepth: number };
  resources: { ramTotalMb: number; ramFreeMb: number; minHeadroomMb: number; maxRequestBytes: number };
  privacy: { accepts: "shareable-only"; retainsPrompts: false };
  pricing: { microsPerKiloToken: number; payee?: string };
  capabilities: PublicModelCapability[];
}
export type PublicAdvertFailure = "invalid_advert" | "authentication_failure" | "stale_advert" | "self_provider" | "privacy_mismatch" | "capability_mismatch" | "context_too_large" | "tools_unsupported" | "price_too_high" | "overloaded_provider" | "insufficient_memory" | "unreachable_provider" | "self_dealing";
export interface PublicComputeNeed {
  task: PublicComputeTask; alias?: string; contextTokens: number; requiresTools: boolean; sensitivity: "private" | "shareable";
  maxPriceMicrosPerKiloToken?: number; minMemoryHeadroomMb?: number; requesterProviderIds?: string[]; requesterTransportKeys?: string[]; requesterPayee?: string;
  requiredTransportKey?: string;
  /** transport key -> measured connect latency, or false when a probe failed. */ reachability?: Record<string, number | false>;
}
export interface PublicProviderCandidate {
  advert: PublicProviderAdvert; capability: PublicModelCapability; score: number; reason: string;
  fields: { price: number; loadPermille: number; latencyMs: number; memoryHeadroomMb: number };
}
export interface PublicProviderSelection { winner: PublicProviderCandidate | null; eligible: PublicProviderCandidate[]; rejected: Array<{ providerId: string; reason: PublicAdvertFailure; detail: string }> }

const HEX_32 = /^[0-9a-f]{64}$/i;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const TASKS = new Set<PublicComputeTask>(["chat", "health", "vision", "embedding", "speech_to_text", "text_to_speech"]);
const finiteInt = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const privateIpv4 = (host: string): boolean => {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 169 && parts[1] === 254);
};

/** Strictly validate an untrusted payload and bind it to its authenticated Hypercore author. */
export function parsePublicProviderAdvert(input: unknown, author: string, now = Date.now()): { ok: true; advert: PublicProviderAdvert } | { ok: false; reason: PublicAdvertFailure; detail: string } {
  if (!obj(input)) return { ok: false, reason: "invalid_advert", detail: "advert is not an object" };
  if (input["version"] !== 1 || input["kind"] !== PUBLIC_COMPUTE_ADVERT_KIND) return { ok: false, reason: "invalid_advert", detail: "unsupported advert version/kind" };
  if (typeof input["providerId"] !== "string" || input["providerId"] !== author || !HEX_32.test(author)) return { ok: false, reason: "authentication_failure", detail: "providerId does not match authenticated cell author" };
  if (typeof input["transportKey"] !== "string" || !HEX_32.test(input["transportKey"])) return { ok: false, reason: "invalid_advert", detail: "invalid transport key" };
  if (!Array.isArray(input["lanEndpoints"]) || input["lanEndpoints"].length > 8) return { ok: false, reason: "invalid_advert", detail: "invalid LAN endpoints" };
  for (const endpoint of input["lanEndpoints"]) {
    if (!obj(endpoint) || typeof endpoint["host"] !== "string" || !privateIpv4(endpoint["host"]) || !finiteInt(endpoint["port"], 1024, 65_535)) return { ok: false, reason: "invalid_advert", detail: "invalid LAN endpoint" };
  }
  if (typeof input["cellId"] !== "string" || !SAFE_ID.test(input["cellId"])) return { ok: false, reason: "invalid_advert", detail: "invalid cell id" };
  if (typeof input["displayName"] !== "string" || input["displayName"].length < 1 || input["displayName"].length > 80) return { ok: false, reason: "invalid_advert", detail: "invalid display name" };
  if (!finiteInt(input["issuedAt"], 1) || !finiteInt(input["expiresAt"], 1) || (input["expiresAt"] as number) <= (input["issuedAt"] as number) || (input["expiresAt"] as number) - (input["issuedAt"] as number) > PUBLIC_COMPUTE_ADVERT_TTL_MS * 2) return { ok: false, reason: "invalid_advert", detail: "invalid advert lifetime" };
  if ((input["issuedAt"] as number) > now + 10_000) return { ok: false, reason: "invalid_advert", detail: "advert issued in the future" };
  if ((input["expiresAt"] as number) <= now) return { ok: false, reason: "stale_advert", detail: "advert expired" };
  if (typeof input["nonce"] !== "string" || !/^[0-9a-f]{32,64}$/i.test(input["nonce"])) return { ok: false, reason: "invalid_advert", detail: "invalid nonce" };
  const availability = input["availability"], resources = input["resources"], privacy = input["privacy"], pricing = input["pricing"];
  if (!obj(availability) || typeof availability["accepting"] !== "boolean" || !finiteInt(availability["inflight"], 0, 1024) || !finiteInt(availability["maxConcurrent"], 1, 1024) || !finiteInt(availability["queueDepth"], 0, 100_000)) return { ok: false, reason: "invalid_advert", detail: "invalid availability" };
  if (!obj(resources) || !finiteInt(resources["ramTotalMb"], 1) || !finiteInt(resources["ramFreeMb"], 0) || (resources["ramFreeMb"] as number) > (resources["ramTotalMb"] as number) || !finiteInt(resources["minHeadroomMb"], 0) || !finiteInt(resources["maxRequestBytes"], 1024, 64 * 1024 * 1024)) return { ok: false, reason: "invalid_advert", detail: "invalid resources" };
  if (!obj(privacy) || privacy["accepts"] !== "shareable-only" || privacy["retainsPrompts"] !== false) return { ok: false, reason: "invalid_advert", detail: "invalid privacy policy" };
  if (!obj(pricing) || !finiteInt(pricing["microsPerKiloToken"], 0, 1_000_000_000) || (pricing["payee"] !== undefined && (typeof pricing["payee"] !== "string" || (pricing["payee"] as string).length > 128))) return { ok: false, reason: "invalid_advert", detail: "invalid pricing" };
  if (!Array.isArray(input["capabilities"]) || input["capabilities"].length < 1 || input["capabilities"].length > 64) return { ok: false, reason: "invalid_advert", detail: "invalid capabilities" };
  for (const cap of input["capabilities"]) {
    if (!obj(cap) || typeof cap["task"] !== "string" || !TASKS.has(cap["task"] as PublicComputeTask) || typeof cap["alias"] !== "string" || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(cap["alias"]) || !finiteInt(cap["contextWindow"], 256, 1_048_576) || typeof cap["tools"] !== "boolean" || !finiteInt(cap["maxOutputTokens"], 1, 65_536)) return { ok: false, reason: "invalid_advert", detail: "invalid capability" };
  }
  return { ok: true, advert: input as unknown as PublicProviderAdvert };
}

function reject(out: PublicProviderSelection["rejected"], a: PublicProviderAdvert, reason: PublicAdvertFailure, detail: string): void { out.push({ providerId: a.providerId, reason, detail }); }

/** Deterministically filter and rank authenticated, live providers for the actual request. */
export function selectPublicProvider(adverts: PublicProviderAdvert[], need: PublicComputeNeed, now = Date.now()): PublicProviderSelection {
  const rejected: PublicProviderSelection["rejected"] = [], eligible: PublicProviderCandidate[] = [];
  const ownProviders = new Set(need.requesterProviderIds ?? []), ownTransports = new Set(need.requesterTransportKeys ?? []);
  for (const a of adverts) {
    if (a.expiresAt <= now) { reject(rejected, a, "stale_advert", "heartbeat TTL expired"); continue; }
    if (need.requiredTransportKey && a.transportKey !== need.requiredTransportKey) { reject(rejected, a, "capability_mismatch", "provider was not the explicitly selected transport" ); continue; }
    if (ownProviders.has(a.providerId) || ownTransports.has(a.transportKey)) { reject(rejected, a, "self_provider", "requester device excluded"); continue; }
    if (need.sensitivity !== "shareable") { reject(rejected, a, "privacy_mismatch", "public providers accept shareable jobs only"); continue; }
    if (!a.availability.accepting || a.availability.inflight >= a.availability.maxConcurrent) { reject(rejected, a, "overloaded_provider", "provider has no concurrency slot"); continue; }
    const cap = a.capabilities.find((c) => c.task === need.task && (!need.alias || c.alias === need.alias));
    if (!cap) { reject(rejected, a, "capability_mismatch", `no ${need.task}${need.alias ? `/${need.alias}` : ""} capability`); continue; }
    if (need.contextTokens > cap.contextWindow) { reject(rejected, a, "context_too_large", `${need.contextTokens} > ${cap.contextWindow}`); continue; }
    if (need.requiresTools && !cap.tools) { reject(rejected, a, "tools_unsupported", "request requires tools"); continue; }
    if (a.pricing.microsPerKiloToken > (need.maxPriceMicrosPerKiloToken ?? Number.MAX_SAFE_INTEGER)) { reject(rejected, a, "price_too_high", "provider exceeds price cap"); continue; }
    if (need.requesterPayee && a.pricing.payee && need.requesterPayee.toLowerCase() === a.pricing.payee.toLowerCase()) { reject(rejected, a, "self_dealing", "payer and provider payee are identical"); continue; }
    const headroom = a.resources.ramFreeMb - a.resources.minHeadroomMb;
    if (headroom < (need.minMemoryHeadroomMb ?? 0)) { reject(rejected, a, "insufficient_memory", "memory headroom below request minimum"); continue; }
    const probe = need.reachability?.[a.transportKey];
    if (probe === false) { reject(rejected, a, "unreachable_provider", "reachability probe failed"); continue; }
    const loadPermille = Math.round((a.availability.inflight / a.availability.maxConcurrent) * 1000);
    const latencyMs = typeof probe === "number" ? Math.max(0, Math.round(probe)) : 10_000;
    const score = a.pricing.microsPerKiloToken * 1_000_000 + loadPermille * 10_000 + latencyMs * 10 - Math.min(headroom, 9_999);
    eligible.push({ advert: a, capability: cap, score, fields: { price: a.pricing.microsPerKiloToken, loadPermille, latencyMs, memoryHeadroomMb: headroom }, reason: `${cap.task}/${cap.alias} · tools ${cap.tools ? "yes" : "no"} · ctx ${cap.contextWindow} · ${a.pricing.microsPerKiloToken}µ/ktok · load ${a.availability.inflight}/${a.availability.maxConcurrent} · headroom ${headroom}MB · reachability ${typeof probe === "number" ? `${latencyMs}ms` : "unmeasured"}` });
  }
  eligible.sort((a, b) => a.score - b.score || a.advert.providerId.localeCompare(b.advert.providerId));
  return { winner: eligible[0] ?? null, eligible, rejected };
}
