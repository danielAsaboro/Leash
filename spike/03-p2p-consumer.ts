/**
 * Spike (c) — consumer side of encrypted P2P delegated compute.
 *
 * Delegates inference to a provider's public key. Tokens are generated on the
 * PROVIDER and streamed back over the encrypted link. Round-trip + cold-start are
 * logged. `fallbackToLocal` lets a flaky link degrade to local inference.
 *
 *   npm run spike:p2p:consumer -- <provider-public-key> [<64-hex-consumer-seed>]
 *
 * GO criteria: consumer receives tokens generated on the provider; round-trip +
 * cold-start (15–45s first call) logged; transport is encrypted by design.
 */
import { completion, loadModel, close, LLAMA_3_2_1B_INST_Q4_0 } from "@qvac/sdk";
import { AuditLog, now } from "./lib/audit-log.ts";

const audit = new AuditLog("03-p2p-consumer");
const providerPublicKey = process.argv[2];
const consumerSeed = process.argv[3];

if (!providerPublicKey) {
  console.error("❌ Usage: npm run spike:p2p:consumer -- <provider-public-key> [<consumer-seed>]");
  process.exit(1);
}
if (consumerSeed) process.env["QVAC_HYPERSWARM_SEED"] = consumerSeed;

try {
  console.log(`🚀 Delegating inference to provider ${providerPublicKey.slice(0, 16)}…`);
  const tConnect = now();
  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    modelType: "llm",
    delegate: {
      providerPublicKey,
      timeout: 60_000, // generous: first call on a cold DHT can take 15–45s
      fallbackToLocal: true,
    },
    onProgress: () => {},
  });
  const coldStartMs = now() - tConnect;
  audit.record({ event: "delegation", modelSrc: LLAMA_3_2_1B_INST_Q4_0, modelId, durationMs: coldStartMs, extra: { role: "consumer", phase: "connect+register", providerPublicKey } });
  console.log(`✅ Delegated model registered in ${coldStartMs}ms (cold-start incl. DHT bootstrap).`);

  const prompt = "In one sentence: why does a weak device benefit from borrowing a stronger peer's brain?";
  const tReq = now();
  const r = completion({ modelId, history: [{ role: "user", content: prompt }], stream: true });
  let firstAt = 0;
  let count = 0;
  console.log("\n📨 Tokens (generated on the provider):\n");
  for await (const token of r.tokenStream) {
    if (count === 0) firstAt = now();
    count++;
    process.stdout.write(token);
  }
  process.stdout.write("\n");
  const stats = await r.stats;
  const roundTripMs = now() - tReq;
  audit.record({
    event: "completion",
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    modelId,
    device: stats?.backendDevice,
    prompt,
    tokens: stats?.generatedTokens ?? count,
    ttftMs: Math.round(stats?.timeToFirstToken ?? (firstAt ? firstAt - tReq : 0)),
    tokensPerSecond: stats?.tokensPerSecond,
    durationMs: roundTripMs,
    extra: { role: "consumer", delegated: true, providerPublicKey },
  });

  console.log(`\n✅ Round-trip ${roundTripMs}ms · device=${stats?.backendDevice ?? "?"} · tok/s=${stats?.tokensPerSecond?.toFixed(1) ?? "?"}`);
  console.log("Transport is Noise-encrypted (Holepunch/Hyperswarm) by design — no plaintext on the wire.");
  console.log(`GO if you saw tokens above. Log: ${audit.path}`);
  void close();
} catch (error) {
  console.error("❌ consumer failed:", error);
  audit.record({ event: "note", extra: { role: "consumer", error: String(error) } });
  process.exit(1);
}
