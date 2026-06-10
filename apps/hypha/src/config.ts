/**
 * Hypha config — paths, persisted identity, and env knobs for the delegated-compute daemon.
 *
 * Everything device-specific (the mesh corestore, the 64-hex hyperswarm seed, the printed
 * invite) lives under `mycelium/data/hypha/` (gitignored). The seed is generated once and
 * persisted so the device's provider public key — and therefore its firewall identity —
 * is stable across restarts (the SDK has no auto-reconnect; a stable key lets warm peers
 * re-find us). Because provider AND consumer share `QVAC_HYPERSWARM_SEED` in this one
 * process, the device's consumer connect-key equals its provider public key; we gossip it
 * as both and allow-list peers by that single key.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { totalmem, hostname, homedir } from "node:os";
import type { ComputeClass, PowerState } from "@mycelium/shared";

const here = dirname(fileURLToPath(import.meta.url));
/** Repo root (apps/hypha/src → ../../..). */
export const REPO_ROOT = join(here, "..", "..", "..");
/** Shared data dir (next to leash's stores + the model catalog). */
export const DATA_DIR = join(REPO_ROOT, "data");
/**
 * This device's private Hypha state (seed, mesh-store, invite) — gitignored. Override with
 * HYPHA_DATA_DIR to run a SECOND instance on one machine (the two-process dev checkpoint):
 * give each its own dir + HYPHA_PORT so their corestores/seeds/ports don't collide.
 */
export const HYPHA_DATA_DIR = process.env["HYPHA_DATA_DIR"] ?? join(DATA_DIR, "hypha");
/** Durable local-first provider economy state (sessions, replay guards, receipts, blocks). */
export const HYPHA_ECONOMY_DIR = join(HYPHA_DATA_DIR, "economy");
/**
 * The persistent ROOT corestore (the MeshHost's store): every mesh this device belongs to is a
 * namespace inside it (the primary mesh on the default namespace — spec §3.1). Reopened across
 * restarts to rejoin all meshes.
 */
export const MESH_STORE_DIR = join(HYPHA_DATA_DIR, "mesh-store");
/**
 * Index of this device's memberships (meshId + label + type + tier) — the list the daemon reopens
 * at boot. Absent + an existing `MESH_STORE_DIR` = a pre-multi-mesh device → migrated as PRIMARY.
 */
export const MESHES_FILE = join(HYPHA_DATA_DIR, "meshes.json");
/** Where the host writes a minted blind-pairing invite for a peer to read/copy. */
export const INVITE_FILE = join(HYPHA_DATA_DIR, "invite.txt");
/** 64-hex hyperswarm/provider seed (this device's stable mesh identity). */
export const SEED_FILE = join(HYPHA_DATA_DIR, "seed.txt");
/** Local tombstones: device keys this device has disconnected/forgotten (hidden everywhere locally). */
export const FORGOTTEN_FILE = join(HYPHA_DATA_DIR, "forgotten.json");
/**
 * Unpair ack guard: map of pair-edge key → last acknowledged unpair ts. The daemon only ACTS
 * on a replicated unpair record newer than its ack — so a stale `active:true` arriving late
 * can't silently re-tombstone a device the user just restored/re-paired.
 */
export const UNPAIR_ACK_FILE = join(HYPHA_DATA_DIR, "unpair-ack.json");
/** Audit JSONL dir (evidence bundle). */
export const LOG_DIR = join(here, "..", "logs");
/** Serve alias config DATA (machine-neutral `~/` paths; `qvac.config.mjs` wraps it for the CLI/SDK). */
export const QVAC_CONFIG_FILE = join(REPO_ROOT, "qvac.config.base.json");
/** Cached `@qvac/ai-sdk-provider` allModels dump (name → registryPath/cacheFile). */
export const CATALOG_FILE = join(DATA_DIR, "leash-models-catalog.json");

/** OpenAI-shim + localhost pairing-control port the broker/dashboard talk to. */
export const HYPHA_PORT = Number(process.env["HYPHA_PORT"] ?? 11437);
/** LAN-facing pairing port (the ONLY non-localhost surface; open only in pairing mode). */
export const HYPHA_PAIR_PORT = Number(process.env["HYPHA_PAIR_PORT"] ?? 11438);
/** How long "Add a device" stays discoverable before auto-exiting pairing mode. */
export const PAIR_MODE_TIMEOUT_MS = Number(process.env["HYPHA_PAIR_TIMEOUT_MS"] ?? 180_000);
/** Local serve (broker upstream) — used to read which aliases are actually served here. */
export const LOCAL_SERVE_URL = (process.env["HYPHA_SERVE_URL"] ?? "http://127.0.0.1:11435").replace(/\/+$/, "");
/** Heartbeat cadence (fresh lastSeen + live inflight). */
export const HEARTBEAT_MS = Number(process.env["HYPHA_HEARTBEAT_MS"] ?? 10_000);
/** A peer whose lastSeen is older than this is stale → drop its warm entry, stop delegating. */
export const STALE_MS = Number(process.env["HYPHA_STALE_MS"] ?? 30_000);
/** How often the consumer reconciles warm models against live peers. */
export const WARM_TICK_MS = Number(process.env["HYPHA_WARM_TICK_MS"] ?? 5_000);

// Consumer connectivity self-heal (resilient reconnection). Default OFF → the manager is never
// started → proven core byte-identical. A clean provider restart already self-heals via the SDK's
// own per-RPC reconnect; this targets device sleep/wake + network roam (suspend()+resume()+re-warm).
// See docs/superpowers/specs/2026-06-10-resilient-reconnection-design.md.
export const HYPHA_RESILIENT_RECONNECT = (process.env["HYPHA_RESILIENT_RECONNECT"] ?? "0") === "1";
export const HYPHA_RECONNECT_INTERVAL_MS = Number(process.env["HYPHA_RECONNECT_INTERVAL_MS"] ?? 15_000);
export const HYPHA_RECONNECT_WAKE_GAP_MS = Number(process.env["HYPHA_RECONNECT_WAKE_GAP_MS"] ?? 30_000);
export const HYPHA_RECONNECT_HEAL_COOLDOWN_MS = Number(process.env["HYPHA_RECONNECT_HEAL_COOLDOWN_MS"] ?? 30_000);
export const HYPHA_RECONNECT_ALLFAIL_THRESHOLD = Number(process.env["HYPHA_RECONNECT_ALLFAIL_THRESHOLD"] ?? 2);
export const HYPHA_RECONNECT_PROBE_TIMEOUT_MS = Number(process.env["HYPHA_RECONNECT_PROBE_TIMEOUT_MS"] ?? 4_000);
/**
 * Max wait for the FIRST delegated token (TTFB). A peer that registers a delegated load but
 * dies at decode (e.g. its modelSrc path doesn't exist on its disk) otherwise hangs the shim
 * silently forever — the no-token hang. On timeout the shim errors loudly and drops the warm
 * entry so the pool re-warms fresh.
 */
export const HYPHA_TTFB_MS = Number(process.env["HYPHA_TTFB_MS"] ?? 60_000);

/** KV-cache sessions on delegated completions (kill switch: HYPHA_KV_CACHE=0). */
export const HYPHA_KV_CACHE = (process.env["HYPHA_KV_CACHE"] ?? "1") !== "0";
/** Max concurrently-tracked kv sessions (LRU-evicted beyond this). */
export const HYPHA_KV_MAX_SESSIONS = Number(process.env["HYPHA_KV_MAX_SESSIONS"] ?? 8);
/** Janitor TTL for this device's provider-side `shim.*` cache dirs. */
export const HYPHA_KV_TTL_MS = Number(process.env["HYPHA_KV_TTL_MS"] ?? 24 * 60 * 60 * 1000);
/** Where the SDK keeps kv-cache .bins on THIS device (when it acts as provider). */
export const HYPHA_KV_DIR = process.env["HYPHA_KV_DIR"] ?? join(homedir(), ".qvac", "kv-cache");

/** Coarse device self-description for the capability registry (env-overridable). */
export const DEVICE_NAME = process.env["HYPHA_NAME"] ?? hostname();
export const COMPUTE_CLASS = (process.env["HYPHA_COMPUTE_CLASS"] ?? "mac") as ComputeClass;
export const POWER_STATE = (process.env["HYPHA_POWER"] ?? "plugged") as PowerState;
export const RAM_MB = Math.round(totalmem() / (1024 * 1024));

// ── Machine Economy (optional; disabled unless a Solana wallet + mint are configured) ─────────
/** Enable bounded agentic settlement for delegated compute. */
export const HYPHA_ECONOMY_ENABLED = (process.env["HYPHA_ECONOMY_ENABLED"] ?? "0") === "1";
/** Plasma / EVM-first rail. */
export const HYPHA_ECONOMY_PLASMA_RPC_URL = process.env["HYPHA_ECONOMY_PLASMA_RPC_URL"] ?? "";
export const HYPHA_ECONOMY_PLASMA_NETWORK_ID = process.env["HYPHA_ECONOMY_PLASMA_NETWORK_ID"] ?? "eip155:9745";
export const HYPHA_ECONOMY_PLASMA_MNEMONIC = process.env["HYPHA_ECONOMY_PLASMA_MNEMONIC"] ?? "";
export const HYPHA_ECONOMY_PLASMA_ASSET_MINT = process.env["HYPHA_ECONOMY_PLASMA_ASSET_MINT"] ?? "";
export const HYPHA_ECONOMY_PLASMA_ASSET_SYMBOL = process.env["HYPHA_ECONOMY_PLASMA_ASSET_SYMBOL"] ?? "USDT";
export const HYPHA_ECONOMY_PLASMA_ASSET_DECIMALS = Number(process.env["HYPHA_ECONOMY_PLASMA_ASSET_DECIMALS"] ?? 6);
/** Solana RPC used for settlement (mainnet/devnet/test-validator). */
export const HYPHA_ECONOMY_SOLANA_RPC_URL = process.env["HYPHA_ECONOMY_SOLANA_RPC_URL"] ?? "";
/** Hot-wallet secret key path (JSON uint8 array). */
export const HYPHA_ECONOMY_SOLANA_SECRET_KEY_FILE = process.env["HYPHA_ECONOMY_SOLANA_SECRET_KEY_FILE"] ?? "";
/** Hot-wallet secret key inline (JSON uint8 array or base58) if you don't want a file. */
export const HYPHA_ECONOMY_SOLANA_SECRET_KEY = process.env["HYPHA_ECONOMY_SOLANA_SECRET_KEY"] ?? "";
/** Solana fallback rail. */
export const HYPHA_ECONOMY_SOLANA_NETWORK_ID = process.env["HYPHA_ECONOMY_SOLANA_NETWORK_ID"] ?? "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const HYPHA_ECONOMY_SOLANA_ASSET_MINT = process.env["HYPHA_ECONOMY_SOLANA_ASSET_MINT"] ?? "";
export const HYPHA_ECONOMY_SOLANA_ASSET_SYMBOL = process.env["HYPHA_ECONOMY_SOLANA_ASSET_SYMBOL"] ?? "USDT";
export const HYPHA_ECONOMY_SOLANA_ASSET_DECIMALS = Number(process.env["HYPHA_ECONOMY_SOLANA_ASSET_DECIMALS"] ?? 6);
/** Units are base units of the settlement asset (e.g. micro-USDT when decimals = 6). */
export const HYPHA_ECONOMY_PRICE_PER_KTOK = Number(process.env["HYPHA_ECONOMY_PRICE_PER_KTOK"] ?? 1_000);
export const HYPHA_ECONOMY_FLOAT = Number(process.env["HYPHA_ECONOMY_FLOAT"] ?? 50_000);
export const HYPHA_ECONOMY_MAX_PER_TX = Number(process.env["HYPHA_ECONOMY_MAX_PER_TX"] ?? 5_000);
export const HYPHA_ECONOMY_MAX_PER_HOUR = Number(process.env["HYPHA_ECONOMY_MAX_PER_HOUR"] ?? 20_000);
export const HYPHA_ECONOMY_MAX_PER_COUNTERPARTY = Number(process.env["HYPHA_ECONOMY_MAX_PER_COUNTERPARTY"] ?? 10_000);

// ── Metered / pay-as-you-go streaming settlement (opt-in; OFF = the proven single-settle close) ──
/** Enable metered sessions: escalating per-chunk authorizations + an idle force-settle watchdog. */
export const HYPHA_ECONOMY_METERED = (process.env["HYPHA_ECONOMY_METERED"] ?? "0") === "1";
/** Tokens decoded per chunk before the consumer must advance the authorization. */
export const HYPHA_ECONOMY_CHUNK_TOKENS = Number(process.env["HYPHA_ECONOMY_CHUNK_TOKENS"] ?? 64);
/** Idle window: no advance within this → the provider watchdog force-settles the authorized cap. */
export const HYPHA_ECONOMY_ADVANCE_WINDOW_MS = Number(process.env["HYPHA_ECONOMY_ADVANCE_WINDOW_MS"] ?? 20_000);
/** Test-only: honor a request `stallMs` (consumer goes silent mid-metered-session to trigger the
 *  provider's abandon watchdog). OFF in production — never expose a stall hook on a real deployment. */
export const HYPHA_ECONOMY_TEST_HOOKS = (process.env["HYPHA_ECONOMY_TEST_HOOKS"] ?? "0") === "1";
/** On a metered watchdog cutoff, also CUT the stalled consumer's live link (transient firewall exclude,
 *  NOT an unpair) on top of force-settling the money. Phase 1 proved firewall revocation drops a live
 *  link; this is the non-destructive cooldown version. OFF = money backstop only (the proven path). */
export const HYPHA_ECONOMY_REVOKE_ON_CUTOFF = (process.env["HYPHA_ECONOMY_REVOKE_ON_CUTOFF"] ?? "0") === "1";
/** Cooldown (ms) a cut-off consumer stays firewall-excluded before it auto-re-admits (can reconnect). */
export const HYPHA_ECONOMY_REVOKE_TTL_MS = Number(process.env["HYPHA_ECONOMY_REVOKE_TTL_MS"] ?? 30_000);

// ── Reputation-weighted routing (opt-in; OFF = free-first inflight routing, the proven path) ──────
/** Tie-break PAID delegation targets by effective_cost = pricePerKiloToken / quality (free peers
 *  stay first). The reputation store + GET /reputation are always read-only; this flag only changes
 *  routing. */
export const HYPHA_REPUTATION = (process.env["HYPHA_REPUTATION"] ?? "0") === "1";

// ── Mesh model sharing (P2P weight distribution; advisory) ───────────────────────────────────────
/** Whether this node SHARES its cached models with the mesh — peers may discover + pull them P2P.
 *  Advisory only (the blob swarm seeds regardless); it gates whether peers' UIs offer to pull from
 *  this node, and is shown as a per-node toggle in Leash. Runtime-togglable via POST /models/share. */
export const HYPHA_SHARE_MODELS = (process.env["HYPHA_SHARE_MODELS"] ?? "1") !== "0";

// ── Costly identity Tier-1 (Phase 4; OFF = no binding, no on-chain verification — proven core intact) ──
/** Provider-side: advertise a wallet↔provider-key `identityProof` (signed by the payout wallet) in caps. */
export const HYPHA_ECONOMY_IDENTITY_BINDING = (process.env["HYPHA_ECONOMY_IDENTITY_BINDING"] ?? "0") === "1";
/** Consumer-side: a settled receipt counts toward reputation only if its txHash is verified ON-CHAIN to
 *  have moved the asset to the provider's BOUND payee; unbound/unverified providers are floored (slashed). */
export const HYPHA_ECONOMY_VERIFY_RECEIPTS = (process.env["HYPHA_ECONOMY_VERIFY_RECEIPTS"] ?? "0") === "1";

/**
 * Load this device's persisted 64-hex seed, generating + persisting one on first run.
 * Sets the provider identity (stable provider public key across restarts).
 */
export function loadOrCreateSeed(): string {
  mkdirSync(HYPHA_DATA_DIR, { recursive: true });
  if (existsSync(SEED_FILE)) {
    const seed = readFileSync(SEED_FILE, "utf-8").trim();
    if (/^[0-9a-f]{64}$/i.test(seed)) return seed;
  }
  const seed = randomBytes(32).toString("hex");
  writeFileSync(SEED_FILE, seed);
  return seed;
}
