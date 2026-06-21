import assert from "node:assert/strict";
import {
  PUBLIC_COMPUTE_ADVERT_KIND,
  parsePublicProviderAdvert,
  selectPublicProvider,
  type PublicProviderAdvert,
} from "../src/public-compute.ts";

const now = 1_800_000_000_000;
const provider = (id: string, patch: Partial<PublicProviderAdvert> = {}): PublicProviderAdvert => ({
  version: 1, kind: PUBLIC_COMPUTE_ADVERT_KIND, cellId: "edge-ai", providerId: id, transportKey: id.replace(/^./, "f"), displayName: `provider-${id.slice(0, 4)}`,
  lanEndpoints: [{ host: "192.168.1.20", port: 11_449 }],
  issuedAt: now - 1_000, expiresAt: now + 20_000, nonce: "ab".repeat(16),
  availability: { accepting: true, inflight: 0, maxConcurrent: 2, queueDepth: 0 },
  resources: { ramTotalMb: 36_864, ramFreeMb: 20_000, minHeadroomMb: 2_048, maxRequestBytes: 8 * 1024 * 1024 },
  privacy: { accepts: "shareable-only", retainsPrompts: false }, pricing: { microsPerKiloToken: 100 },
  capabilities: [{ task: "chat", alias: "chat", contextWindow: 32_768, tools: true, maxOutputTokens: 2_048 }],
  ...patch,
});
const aId = "a".repeat(64), bId = "b".repeat(64);
const a = provider(aId), b = provider(bId, { pricing: { microsPerKiloToken: 50 }, availability: { accepting: true, inflight: 1, maxConcurrent: 2, queueDepth: 0 } });

assert.equal(parsePublicProviderAdvert(a, aId, now).ok, true, "authenticated author accepted");
assert.equal(parsePublicProviderAdvert(a, bId, now).ok, false, "wrong signed author rejected");
assert.equal(parsePublicProviderAdvert({ ...a, expiresAt: now - 1 }, aId, now).ok, false, "expired advert rejected");
assert.equal(parsePublicProviderAdvert({ ...a, capabilities: [{ ...a.capabilities[0]!, contextWindow: 0 }] }, aId, now).ok, false, "malicious capability rejected");
assert.equal(parsePublicProviderAdvert({ ...a, lanEndpoints: [{ host: "8.8.8.8", port: 11_449 }] }, aId, now).ok, false, "public-IP SSRF hint rejected");

const base = { task: "chat" as const, alias: "chat", contextTokens: 2_000, requiresTools: false, sensitivity: "shareable" as const };
assert.equal(selectPublicProvider([a, b], base, now).winner?.advert.providerId, bId, "lower price wins deterministically");
assert.equal(selectPublicProvider([a, b], { ...base, requiredTransportKey: a.transportKey }, now).winner?.advert.providerId, aId, "explicit provider is honored");
assert.equal(selectPublicProvider([a], { ...base, sensitivity: "private" }, now).rejected[0]?.reason, "privacy_mismatch");
assert.equal(selectPublicProvider([a], { ...base, contextTokens: 40_000 }, now).rejected[0]?.reason, "context_too_large");
assert.equal(selectPublicProvider([{ ...a, capabilities: [{ ...a.capabilities[0]!, tools: false }] }], { ...base, requiresTools: true }, now).rejected[0]?.reason, "tools_unsupported");
assert.equal(selectPublicProvider([{ ...a, availability: { accepting: true, inflight: 2, maxConcurrent: 2, queueDepth: 0 } }], base, now).rejected[0]?.reason, "overloaded_provider");
assert.equal(selectPublicProvider([a], { ...base, requesterProviderIds: [aId] }, now).rejected[0]?.reason, "self_provider");
assert.equal(selectPublicProvider([a], { ...base, reachability: { [a.transportKey]: false } }, now).rejected[0]?.reason, "unreachable_provider");
assert.equal(selectPublicProvider([{ ...a, pricing: { microsPerKiloToken: 100, payee: "0xabc" } }], { ...base, requesterPayee: "0xAbC" }, now).rejected[0]?.reason, "self_dealing");
assert.equal(selectPublicProvider([{ ...a, resources: { ...a.resources, ramFreeMb: 2_100 } }], { ...base, minMemoryHeadroomMb: 100 }, now).rejected[0]?.reason, "insufficient_memory");

console.log("✅ public-compute policy — authenticated adverts, TTL, eligibility, deterministic ranking, self/reachability/load/privacy/tools/context/memory gates");
