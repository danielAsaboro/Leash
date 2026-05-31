/**
 * Spike (c) — provider side of encrypted P2P delegated compute.
 *
 * Starts a QVAC provider (the "strong brain", e.g. the Mac) and prints its public
 * key. A consumer (03-p2p-consumer.ts, or a real iPhone via Expo) delegates
 * inference to it; tokens are generated HERE and streamed back over the
 * Noise-encrypted Holepunch link.
 *
 *   npm run spike:p2p:provider [-- <64-hex-seed> [<allowed-consumer-pubkey>]]
 *
 * - Pass a 64-char hex seed for a deterministic provider identity (stable key
 *   across restarts — useful for CI / repeatable demos).
 * - Pass an allowed consumer public key to enable the firewall (allow-list).
 */
import { startQVACProvider } from "@qvac/sdk";
import { AuditLog } from "./lib/audit-log.ts";

const audit = new AuditLog("03-p2p-provider");
const seed = process.argv[2];
const allowedConsumerPublicKey = process.argv[3];

if (seed) process.env["QVAC_HYPERSWARM_SEED"] = seed;

try {
  console.log("🚀 Starting QVAC delegated-inference provider…");
  if (allowedConsumerPublicKey) console.log(`🔒 Firewall: allow only ${allowedConsumerPublicKey}`);

  const response = await startQVACProvider({
    firewall: allowedConsumerPublicKey ? { mode: "allow", publicKeys: [allowedConsumerPublicKey] } : undefined,
  });

  audit.record({ event: "delegation", extra: { role: "provider", publicKey: response.publicKey, firewall: Boolean(allowedConsumerPublicKey), deterministicSeed: Boolean(seed) } });

  console.log("\n✅ Provider running. Give this public key to the consumer:\n");
  console.log(`   ${response.publicKey}\n`);
  console.log("Consumer command (another terminal):");
  console.log(`   npm run spike:p2p:consumer -- ${response.publicKey}\n`);
  console.log("📡 Press Ctrl+C to stop. (No auto-reconnect yet — restart the consumer if you restart this.)");

  process.on("SIGINT", () => {
    audit.record({ event: "note", extra: { role: "provider", stopped: true } });
    console.log("\n🛑 Provider stopped");
    process.exit(0);
  });
  process.stdin.resume();
} catch (error) {
  console.error("❌ provider failed:", error);
  audit.record({ event: "note", extra: { role: "provider", error: String(error) } });
  process.exit(1);
}
