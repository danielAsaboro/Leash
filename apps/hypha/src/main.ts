/**
 * Hypha — the headless delegated-compute daemon (Layer 1 — Mesh).
 *
 *   npx tsx apps/hypha/src/main.ts            # run the daemon (shim + pairing; mesh when paired)
 *   npx tsx apps/hypha/src/main.ts invite     # CLI: mint a blind-pairing invite, stay up
 *   npx tsx apps/hypha/src/main.ts pair <hex> # CLI: first-time join against an invite
 *
 * Symmetric: every device runs this. It is BOTH a provider (serves paired peers, firewall-
 * locked to their gossiped consumer keys) and a consumer (pre-warms peers' chat models on
 * the local OpenAI shim the broker sheds overflow to).
 *
 * Lazy mesh: a fresh device runs only the localhost shim + LAN pairing until it actually
 * pairs — there are no peers to serve/gossip to before then. Pairing (CLI or the Services
 * "Add a device" UI) founds or joins a mesh, which brings the provider/heartbeat/warm-pool
 * online. A device with an existing mesh store rejoins it at boot. Because provider and
 * consumer share QVAC_HYPERSWARM_SEED, this device's consumer key equals its provider key.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { close, stopQVACProvider, heartbeat, suspend, resume } from "@qvac/sdk";
import { AuditLog, KvSessions, sweepKvCacheDir, type Visibility, type Reach } from "@mycelium/shared";
import { MeshGraph, MeshHost, PublicMesh, unpairKey, startAdapterSync, supersededDeviceIds, PRIMARY_MESH_ID, type AdapterSyncHandle } from "@mycelium/mesh";
import {
  DEVICE_NAME,
  FORGOTTEN_FILE,
  HYPHA_DATA_DIR,
  HYPHA_ECONOMY_ADVANCE_WINDOW_MS,
  HYPHA_ECONOMY_CHUNK_TOKENS,
  HYPHA_ECONOMY_DIR,
  HYPHA_ECONOMY_ENABLED,
  HYPHA_ECONOMY_FLOAT,
  HYPHA_ECONOMY_IDENTITY_BINDING,
  HYPHA_ECONOMY_METERED,
  HYPHA_ECONOMY_REVOKE_ON_CUTOFF,
  HYPHA_ECONOMY_REVOKE_TTL_MS,
  HYPHA_ECONOMY_VERIFY_RECEIPTS,
  HYPHA_ECONOMY_MAX_PER_COUNTERPARTY,
  HYPHA_ECONOMY_MAX_PER_HOUR,
  HYPHA_ECONOMY_MAX_PER_TX,
  HYPHA_ECONOMY_PLASMA_ASSET_DECIMALS,
  HYPHA_ECONOMY_PLASMA_ASSET_MINT,
  HYPHA_ECONOMY_PLASMA_ASSET_SYMBOL,
  HYPHA_ECONOMY_PLASMA_MNEMONIC,
  HYPHA_ECONOMY_PLASMA_NETWORK_ID,
  HYPHA_ECONOMY_PLASMA_RPC_URL,
  HYPHA_ECONOMY_PRICE_PER_KTOK,
  HYPHA_ECONOMY_SOLANA_ASSET_DECIMALS,
  HYPHA_ECONOMY_SOLANA_ASSET_MINT,
  HYPHA_ECONOMY_SOLANA_ASSET_SYMBOL,
  HYPHA_ECONOMY_SOLANA_NETWORK_ID,
  HYPHA_ECONOMY_SOLANA_RPC_URL,
  HYPHA_ECONOMY_SOLANA_SECRET_KEY,
  HYPHA_ECONOMY_SOLANA_SECRET_KEY_FILE,
  HYPHA_KV_CACHE,
  HYPHA_KV_DIR,
  HYPHA_KV_MAX_SESSIONS,
  HYPHA_KV_TTL_MS,
  HYPHA_PAIR_PORT,
  HYPHA_PORT,
  HYPHA_REPUTATION,
  HYPHA_SHARE_MODELS,
  HYPHA_FORWARD,
  INVITE_FILE,
  LOG_DIR,
  MESH_STORE_DIR,
  MESHES_FILE,
  MODEL_SHARE_FILE,
  STALE_MS,
  UNPAIR_ACK_FILE,
  loadOrCreateSeed,
  HYPHA_RESILIENT_RECONNECT,
  HYPHA_RECONNECT_INTERVAL_MS,
  HYPHA_RECONNECT_WAKE_GAP_MS,
  HYPHA_RECONNECT_HEAL_COOLDOWN_MS,
  HYPHA_RECONNECT_ALLFAIL_THRESHOLD,
  HYPHA_RECONNECT_PROBE_TIMEOUT_MS,
} from "./config.ts";
import { DeviceProvider } from "./device-provider.ts";
import { MeshRouter } from "./mesh-router.ts";
import { startCellDiscovery, type CellDiscoveryHandle } from "./discovery.ts";
import { startMeshServices, type MeshRuntime } from "./mesh-services.ts";
import { ConnectivityManager } from "./connectivity-manager.ts";
import { ReputationStore } from "./reputation.ts";
import { verifyIdentityProof } from "./plasma-settlement.ts";
import { PairingController, type MeshController } from "./pairing.ts";
import { createShim, type Inflight, type MeshControl, type MeshSummary } from "./shim.ts";
import { SolanaSettlementService } from "./solana-settlement.ts";
import { PlasmaSettlementService } from "./plasma-settlement.ts";
import { SettlementManager } from "./settlement-manager.ts";
import { ProviderEconomyService } from "./provider-economy.ts";
import { PaymentControlClient, PaymentControlServer } from "./payment-control.ts";
import { ForwardControlServer, ForwardControlClient } from "./forward-control.ts";
import { createForwardProvider } from "./forward-provider.ts";

/** One membership row persisted in meshes.json — the device's local record of a mesh it belongs to. */
interface MeshRecord {
  meshId: string;
  label: string;
  visibility: Visibility;
  reach: Reach;
  /** Delegation-ladder rank (spec §6) — primary/home = 0, secondaries increasing. */
  tier: number;
  /** True only when THIS device founded the mesh via `foundMesh` (the "New mesh" action) — the
   *  gate for deleting it. Joined/primary/public memberships are not creators (absent = false). */
  creator?: boolean;
  /** The shared mesh's Autobase key (hex), recorded only for meshes this device JOINED. Passed back
   *  as the bootstrapKey on reopen so a restart RE-BINDS to the founder's mesh instead of founding a
   *  fresh fork. Absent for meshes this device founded (they recover their own autobase with no key). */
  bootstrapKey?: string;
}

const audit = new AuditLog("hypha", LOG_DIR);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function makeInflight(): Inflight {
  let n = 0;
  return { inc: () => void n++, dec: () => void (n = Math.max(0, n - 1)), get: () => n };
}

/** `hypha invite` — mint + print an invite and stay up so a candidate can pair (CLI path). */
async function runInvite(): Promise<void> {
  const graph = await MeshGraph.open({ storeDir: MESH_STORE_DIR, audit });
  await graph.joinSwarm();
  const invite = await graph.mintInvite();
  writeFileSync(INVITE_FILE, invite);
  console.log("🔗 Hypha invite — run on the peer:\n");
  console.log(`   npx tsx apps/hypha/src/main.ts pair ${invite}\n`);
  console.log(`(written to ${INVITE_FILE}) — keep this up until the peer pairs, then Ctrl-C and run the daemon.`);
  process.on("SIGINT", () => void graph.close().then(() => process.exit(0)));
  process.stdin.resume();
}

/** `hypha pair <hex>` — first-time join; becomes a writer, then exits (run the daemon next). */
async function runPair(invite: string | undefined): Promise<void> {
  if (!invite) throw new Error("usage: hypha pair <invite-hex>");
  if (existsSync(MESH_STORE_DIR)) throw new Error("this device already has a mesh store — run the daemon (`hypha`) instead of pairing again");
  const graph = await MeshGraph.pair({ storeDir: MESH_STORE_DIR, invite, audit });
  console.log("⏳ paired — waiting to be promoted to a writer…");
  const t0 = Date.now();
  while (Date.now() - t0 < 30_000) {
    await graph.update();
    if (graph.writable) break;
    await sleep(500);
  }
  if (!graph.writable) throw new Error("not promoted to writer within 30s (is the host's invite still up?)");
  console.log("✅ paired and promoted. Now start the daemon on BOTH devices: npx tsx apps/hypha/src/main.ts");
  await graph.close();
}

/** Default — the long-running daemon. */
async function runDaemon(): Promise<void> {
  // Diagnostic (env-gated): probe LAN TCP reachability every 10s to localize when/where this
  // process loses LAN access (observed: EHOSTUNREACH from inside the daemon while every other
  // process on the same box connects fine). HYPHA_DEBUG_LANPROBE=<host:port>
  const lanProbe = process.env["HYPHA_DEBUG_LANPROBE"];
  if (lanProbe) {
    const [host, port] = lanProbe.split(":");
    const { connect } = await import("node:net");
    const t0 = Date.now();
    const probe = (): void => {
      const s = connect(Number(port), host);
      s.on("connect", () => { console.log(`[lanprobe] +${Math.round((Date.now() - t0) / 1000)}s OK`); s.destroy(); });
      s.on("error", (e) => console.log(`[lanprobe] +${Math.round((Date.now() - t0) / 1000)}s ERR ${(e as NodeJS.ErrnoException).code}`));
    };
    probe();
    setInterval(probe, 10_000).unref();
  }
  const seed = loadOrCreateSeed();
  const inflight = makeInflight();
  const plasmaSettlement = new PlasmaSettlementService({
    enabled: HYPHA_ECONOMY_ENABLED,
    rpcUrl: HYPHA_ECONOMY_PLASMA_RPC_URL,
    mnemonic: HYPHA_ECONOMY_PLASMA_MNEMONIC,
    asset: {
      symbol: HYPHA_ECONOMY_PLASMA_ASSET_SYMBOL,
      mint: HYPHA_ECONOMY_PLASMA_ASSET_MINT,
      decimals: HYPHA_ECONOMY_PLASMA_ASSET_DECIMALS,
      networkId: HYPHA_ECONOMY_PLASMA_NETWORK_ID,
    },
    price: { perKiloToken: HYPHA_ECONOMY_PRICE_PER_KTOK },
    limits: {
      maxPerTx: HYPHA_ECONOMY_MAX_PER_TX,
      maxPerHour: HYPHA_ECONOMY_MAX_PER_HOUR,
      maxPerCounterparty: HYPHA_ECONOMY_MAX_PER_COUNTERPARTY,
    },
    initialFloat: HYPHA_ECONOMY_FLOAT,
  });
  const solanaSettlement = new SolanaSettlementService({
    enabled: HYPHA_ECONOMY_ENABLED,
    rpcUrl: HYPHA_ECONOMY_SOLANA_RPC_URL,
    secretKey: HYPHA_ECONOMY_SOLANA_SECRET_KEY,
    secretKeyFile: HYPHA_ECONOMY_SOLANA_SECRET_KEY_FILE,
    asset: {
      symbol: HYPHA_ECONOMY_SOLANA_ASSET_SYMBOL,
      mint: HYPHA_ECONOMY_SOLANA_ASSET_MINT,
      decimals: HYPHA_ECONOMY_SOLANA_ASSET_DECIMALS,
    },
    price: { perKiloToken: HYPHA_ECONOMY_PRICE_PER_KTOK },
    limits: {
      maxPerTx: HYPHA_ECONOMY_MAX_PER_TX,
      maxPerHour: HYPHA_ECONOMY_MAX_PER_HOUR,
      maxPerCounterparty: HYPHA_ECONOMY_MAX_PER_COUNTERPARTY,
    },
    initialFloat: HYPHA_ECONOMY_FLOAT,
  });
  const settlement = new SettlementManager({ plasma: plasmaSettlement, solana: solanaSettlement });
  await settlement.ready();
  // Multi-mesh (spec §3): one MeshHost (root corestore + shared swarm), N memberships. `runtimes`
  // holds every mesh's services; `meshMeta` its label/tier/visibility; `mesh` points at the
  // PRIMARY membership so the existing pairing/tombstone/unpair machinery keeps working unchanged.
  let host: MeshHost | null = null;
  const runtimes = new Map<string, MeshRuntime>();
  const meshMeta = new Map<string, MeshRecord>();
  let mesh: MeshRuntime | null = null;
  // Public cells (spec §9 / direction B): broadcast-only, leaderless gossip meshes, auto-discovered
  // over mDNS — kept SEPARATE from the private compute runtimes (no warm pool, no firewall, no
  // delegation). Keyed by cellId.
  const publicMeshes = new Map<string, { cellId: string; label: string; mesh: PublicMesh; discovery: CellDiscoveryHandle }>();
  // Layer-4: share trained LoRA adapters over the PRIMARY mesh (publish local promotable ones,
  // fetch peers' newer ones). Started once the mesh is online; rides the same swarm.
  let adapterSync: AdapterSyncHandle | null = null;
  const providerEconomy = plasmaSettlement.online()
    ? new ProviderEconomyService({
      seed,
      audit,
      storeDir: HYPHA_ECONOMY_DIR,
      plasma: plasmaSettlement,
      providerPublicKey: () => provider.selfKey,
      resolveMeshParticipant: async (meshId, consumerWriterKey) => {
        const runtime = runtimes.get(meshId);
        const meta = meshMeta.get(meshId);
        if (!runtime || !meta) return null;
        const caps = await runtime.graph.capabilities().catch(() => []);
        const cap = caps.find((entry) => entry.deviceId === consumerWriterKey);
        return { visibility: meta.visibility, providerWriterKey: runtime.graph.localWriterKey, consumerPublicKey: cap?.consumerPublicKey };
      },
      publishReceipt: async (meshId, receipt) => {
        const runtime = runtimes.get(meshId);
        if (!runtime) return;
        await runtime.graph.publishReceipt(receipt).catch(() => undefined);
      },
      // Metered (pay-as-you-go) sessions — opt-in (HYPHA_ECONOMY_METERED=1). OFF = the proven
      // single-settle close path is the only path.
      metered: { enabled: HYPHA_ECONOMY_METERED, chunkTokens: HYPHA_ECONOMY_CHUNK_TOKENS, advanceWindowMs: HYPHA_ECONOMY_ADVANCE_WINDOW_MS },
      // Phase 1 GATE PASS (2026-06-10): a provider firewall stop→start drops a LIVE consumer link
      // (provider firewall went 2→1, post-revoke completion got 503 no_warm_peer). So on a watchdog
      // cutoff we can also CUT the stalled consumer's link — but NON-destructively (a transient
      // firewall exclude with an auto-re-admit cooldown, NOT a forget/unpair, which would removeWriter
      // a possibly-just-blipped paying peer). Opt-in (HYPHA_ECONOMY_REVOKE_ON_CUTOFF); OFF = the money
      // backstop alone (force-settle the authorized cap), the proven path, firewall byte-identical.
      ...(HYPHA_ECONOMY_REVOKE_ON_CUTOFF
        ? { revokeConsumer: (consumerPublicKey: string) => provider.transientRevoke(consumerPublicKey, HYPHA_ECONOMY_REVOKE_TTL_MS) }
        : {}),
    })
    : null;
  const paymentControlServer = providerEconomy ? new PaymentControlServer({ seed, audit, economy: providerEconomy }) : null;
  if (paymentControlServer) await paymentControlServer.ready();
  // SP2 Option B — provider-side forward server: runs forwarded vision (later embed/stt/tts) requests
  // on this device's LOCAL serve. Joins the SAME per-pair firewall topics as payment-control (below).
  const forwardServer = HYPHA_FORWARD ? new ForwardControlServer({ seed, audit, handler: createForwardProvider({ audit }) }) : null;
  if (forwardServer) await forwardServer.ready();
  // The ONE delegated-inference provider for this device + its union firewall (spec §4). Every
  // mesh contributes its paired consumers; the provider serves their union. Lazy: not started
  // until the first mesh comes online.
  const provider = new DeviceProvider(seed, audit, async (providerPublicKey, allowedConsumers) => {
    await paymentControlServer?.updateAllowedConsumers(providerPublicKey, allowedConsumers);
    await forwardServer?.updateAllowedConsumers(providerPublicKey, allowedConsumers);
  });

  // Consumer-side payment-control: ONE persistent client per daemon (stable seed → warm DHT/NAT
  // state, one multiplexed connection per provider). Constructed always (cheap — its swarm is lazy),
  // but only pre-warmed when this device can actually pay (Plasma rail online).
  const paymentControl = new PaymentControlClient(() => provider.selfKey, seed, audit);
  // SP2 Option B — consumer-side forward client (one per daemon; lazy swarm). The shim uses it to
  // borrow vision (and later embed/stt/tts) from a peer's local serve.
  const forwardClient = HYPHA_FORWARD ? new ForwardControlClient(() => provider.selfKey, seed, audit) : null;
  const onPaidPeer = plasmaSettlement.online() ? (providerKey: string) => paymentControl.warm(providerKey) : undefined;
  // Mesh model sharing (advisory): whether peers may discover + pull this node's cached models. A
  // per-node Leash toggle flips it at runtime; flipping re-advertises every mesh so peers see it fast.
  let shareModels = HYPHA_SHARE_MODELS;
  const setShareModels = async (on: boolean): Promise<void> => {
    shareModels = on;
    audit.record({ event: "note", extra: { role: "mesh", phase: "share-models", on } });
    await Promise.all([...runtimes.values()].map((m) => m.advertise().catch(() => undefined)));
  };
  // Per-alias sharing: a persisted DENY-set of serve aliases NOT advertised to the mesh. Empty/absent =
  // share all configured aliases (byte-identical to before). Refines the node-level `shareModels` switch —
  // an alias in this set is filtered out of every mesh's advertised model list (see mesh-services buildCap).
  const unsharedModels = new Set<string>(
    (() => {
      try {
        return existsSync(MODEL_SHARE_FILE) ? ((JSON.parse(readFileSync(MODEL_SHARE_FILE, "utf8")) as { unshared?: string[] }).unshared ?? []) : [];
      } catch {
        return [];
      }
    })(),
  );
  const setAliasShared = async (alias: string, on: boolean): Promise<void> => {
    if (on) unsharedModels.delete(alias);
    else unsharedModels.add(alias);
    try {
      writeFileSync(MODEL_SHARE_FILE, JSON.stringify({ unshared: [...unsharedModels] }, null, 2));
    } catch {
      /* best-effort persistence — the live set still drives advertisement this session */
    }
    audit.record({ event: "note", extra: { role: "mesh", phase: "share-alias", alias, on } });
    await Promise.all([...runtimes.values()].map((m) => m.advertise().catch(() => undefined)));
  };
  // Reputation (Phase 3): always ingest receipts + local observations (read-only); the routing WEIGHT
  // is applied only when HYPHA_REPUTATION is on (else routing is the proven free-first inflight order).
  // Phase 4 (HYPHA_ECONOMY_VERIFY_RECEIPTS): a receipt counts toward reputation only if its tx is verified
  // ON-CHAIN to have moved the asset to the provider's BOUND payee; unbound/unverified providers are
  // floored (slashing-lite). `boundProviders` maps a verified provider key → its bound wallet, refreshed
  // from peers' `identityProof` in the receipt feed loop. Flag OFF → byte-identical Phase-3 scoring.
  const verifyReceipts = HYPHA_ECONOMY_VERIFY_RECEIPTS && plasmaSettlement.online();
  const boundProviders = new Map<string, string>();
  const reputation = new ReputationStore(
    verifyReceipts
      ? {
          verifyReceipt: async (r) =>
            r.providerAddress
              ? plasmaSettlement.verifyTxSettled(r.txHash, r.providerAddress, plasmaSettlement.assetMint(), r.actualAmount)
              : false,
          isBound: (providerId) => boundProviders.has(providerId),
        }
      : {},
  );

  // Local tombstones — devices this one has hard-disconnected. AUTHORITATIVE on this device:
  // a tombstoned peer is hidden from the list, never served, never borrowed from — no matter
  // what the CRDT/sync state is. Persisted so it survives restarts. (CRDT removal is attempted
  // best-effort on top, but the local tombstone is what makes "Disconnect" actually disconnect.)
  const forgotten = new Set<string>(
    (() => {
      try {
        return existsSync(FORGOTTEN_FILE) ? (JSON.parse(readFileSync(FORGOTTEN_FILE, "utf8")) as string[]) : [];
      } catch {
        return [];
      }
    })(),
  );
  const saveForgotten = (): void => {
    try {
      writeFileSync(FORGOTTEN_FILE, JSON.stringify([...forgotten]));
    } catch {
      /* best effort */
    }
  };
  const isForgotten = (id: string): boolean => forgotten.has(id);

  // Unpair ack guard — pair-edge key → last unpair ts this device has ACTED on. A replicated
  // unpair record only takes local effect when its ts is newer than the ack, so a stale
  // `active:true` arriving late can't re-tombstone a device the user just restored/re-paired.
  const unpairAcks = new Map<string, string>(
    (() => {
      try {
        return existsSync(UNPAIR_ACK_FILE) ? Object.entries(JSON.parse(readFileSync(UNPAIR_ACK_FILE, "utf8")) as Record<string, string>) : [];
      } catch {
        return [];
      }
    })(),
  );
  const saveUnpairAcks = (): void => {
    try {
      writeFileSync(UNPAIR_ACK_FILE, JSON.stringify(Object.fromEntries(unpairAcks)));
    } catch {
      /* best effort */
    }
  };
  const stampUnpairAck = (a: string, b: string, ts: string = new Date().toISOString()): void => {
    unpairAcks.set(unpairKey(a, b), ts);
    saveUnpairAcks();
  };

  /**
   * Apply replicated unpair records that name THIS device (and are newer than their ack):
   * active:true → tombstone the other side back (the MUTUAL half of a peer's disconnect);
   * active:false → clear the tombstone (auto-heal on the peer's restore/re-pair). Driven off
   * graph.onChange and once at mesh boot (records may have replicated while we were offline).
   */
  let reconcilingUnpairs = false;
  const reconcileUnpairs = async (m: MeshRuntime): Promise<void> => {
    if (reconcilingUnpairs) return;
    reconcilingUnpairs = true;
    try {
      const self = m.graph.localWriterKey;
      const records = await m.graph.unpairs().catch(() => []);
      let changed = false;
      let acked = false;
      for (const r of records) {
        if (r.a !== self && r.b !== self) continue;
        const other = r.a === self ? r.b : r.a;
        const ack = unpairAcks.get(unpairKey(r.a, r.b));
        if (ack !== undefined && r.ts <= ack) continue;
        if (r.active ? !forgotten.has(other) : forgotten.has(other)) {
          if (r.active) forgotten.add(other);
          else forgotten.delete(other);
          changed = true;
          audit.record({ event: "pairing", extra: { role: "mesh", phase: r.active ? "unpair-applied" : "unpair-retracted", other, ts: r.ts } });
        }
        unpairAcks.set(unpairKey(r.a, r.b), r.ts);
        acked = true;
      }
      if (acked) saveUnpairAcks();
      if (changed) {
        saveForgotten();
        await m.reconcileFirewall().catch(() => undefined);
        await m.pool.reconcile().catch(() => undefined);
      }
    } finally {
      reconcilingUnpairs = false;
    }
  };

  /**
   * Supersede-based ghost cleanup. A device that re-pairs after a mesh-store reset gets a NEW writer key
   * (the cap's `deviceId`) while its `providerPublicKey`/`consumerPublicKey` (the seed-derived identity)
   * stay the same — leaving its old cap as a dead ghost in the grow-only membership set. Forget the
   * superseded writer key. Only a WRITABLE member can append the forget; SAFE — it never forgets a merely
   * offline device (it requires the SAME identity to have REAPPEARED under a new key), unlike a staleness
   * timer (`STALE_MS` is 30s). Driven off graph.onChange + once at mesh boot.
   */
  const supersededForgotten = new Set<string>();
  const reconcileSuperseded = async (m: MeshRuntime): Promise<void> => {
    if (!m.graph.writable) return;
    const caps = await m.graph.capabilities().catch(() => []);
    for (const deviceId of supersededDeviceIds(caps)) {
      if (supersededForgotten.has(deviceId)) continue;
      supersededForgotten.add(deviceId);
      await m.graph.forgetCapability(deviceId).catch(() => undefined);
      audit.record({ event: "capability", extra: { role: "mesh", phase: "supersede-forget", deviceId: deviceId.slice(0, 16) } });
    }
  };

  // ── meshes.json index (the memberships to reopen at boot) ────────────────────────────────────
  const primaryRecord = (): MeshRecord => ({ meshId: PRIMARY_MESH_ID, label: "Primary", visibility: "private", reach: "local", tier: 0 });
  const loadMeshRecords = (): MeshRecord[] => {
    try { return existsSync(MESHES_FILE) ? (JSON.parse(readFileSync(MESHES_FILE, "utf8")) as MeshRecord[]) : []; } catch { return []; }
  };
  const saveMeshRecords = (): void => {
    try { writeFileSync(MESHES_FILE, JSON.stringify([...meshMeta.values()], null, 2)); } catch { /* best effort */ }
  };
  const nextTier = (): number => { const ts = [...meshMeta.values()].map((m) => m.tier); return (ts.length ? Math.max(...ts) : 0) + 1; };

  // One MeshHost owns the root corestore + shared swarm; created lazily so a fresh device stays
  // mesh-less (never founds a store) until it actually pairs/founds.
  let hostOpening: Promise<MeshHost> | null = null;
  const ensureHost = (): Promise<MeshHost> => {
    if (host) return Promise.resolve(host);
    hostOpening ??= MeshHost.open({ rootDir: MESH_STORE_DIR, audit }).then((h) => { host = h; hostOpening = null; return h; });
    return hostOpening;
  };

  /** Every mesh-online path goes through here: start per-mesh services + wire the unpair reconcile. */
  const bringMeshOnline = async (meshId: string, g: MeshGraph, meta: MeshRecord): Promise<MeshRuntime> => {
    const m = await startMeshServices(g, { meshId, provider, settlement, inflight, audit, isForgotten, shareModels: () => shareModels, unsharedAliases: () => unsharedModels, ...(onPaidPeer ? { onPaidPeer } : {}), ...(HYPHA_REPUTATION ? { reputation } : {}), ...(HYPHA_ECONOMY_IDENTITY_BINDING ? { bindIdentity: true } : {}) });
    runtimes.set(meshId, m);
    meshMeta.set(meshId, meta);
    g.onChange(() => { void reconcileUnpairs(m); void reconcileSuperseded(m); });
    void reconcileUnpairs(m);
    void reconcileSuperseded(m);
    if (meshId === PRIMARY_MESH_ID) {
      mesh = m;
      adapterSync ??= startAdapterSync(g, { audit }); // Layer-4 adapter distribution over the primary mesh
    }
    return m;
  };

  /**
   * Lazy PRIMARY bring-up, SERIALIZED. The first PIN confirm FOUNDS it (open + swarm — seconds);
   * a racing retry would re-open the same namespace. All callers share the single in-flight open.
   */
  let primaryOpening: Promise<MeshRuntime> | null = null;
  const ensureMeshOnline = (): Promise<MeshRuntime> => {
    if (mesh) return Promise.resolve(mesh);
    const existing = runtimes.get(PRIMARY_MESH_ID);
    if (existing) { mesh = existing; return Promise.resolve(existing); }
    primaryOpening ??= (async () => {
      try {
        const h = await ensureHost();
        const rec = meshMeta.get(PRIMARY_MESH_ID) ?? primaryRecord();
        const { graph } = await h.openMesh({ meshId: PRIMARY_MESH_ID, ...(rec.bootstrapKey ? { bootstrapKey: Buffer.from(rec.bootstrapKey, "hex") } : {}) });
        return await bringMeshOnline(PRIMARY_MESH_ID, graph, rec);
      } finally {
        primaryOpening = null;
      }
    })();
    return primaryOpening;
  };

  /** Found a brand-new private mesh of your own devices. Returns its local meshId. */
  const foundMesh = async (label: string): Promise<string> => {
    const h = await ensureHost();
    const meshId = randomUUID();
    const meta: MeshRecord = { meshId, label, visibility: "private", reach: "local", tier: nextTier(), creator: true };
    const { graph } = await h.openMesh({ meshId });
    await bringMeshOnline(meshId, graph, meta);
    saveMeshRecords();
    return meshId;
  };

  /**
   * Join a mesh via a blind invite as a membership: the FIRST mesh becomes PRIMARY (default
   * namespace — identity continuity); later ones get a fresh namespace. Used by BOTH the LAN-PIN
   * pairing path and the paste-invite fallback.
   */
  const joinAsMembership = async (invite: string, label: string): Promise<string> => {
    const h = await ensureHost();
    const isPrimary = !runtimes.has(PRIMARY_MESH_ID);
    const meshId = isPrimary ? PRIMARY_MESH_ID : randomUUID();
    const meta: MeshRecord = isPrimary ? { ...primaryRecord(), label } : { meshId, label, visibility: "private", reach: "local", tier: nextTier(), creator: false };
    try {
      const { graph } = await h.pairMesh({ meshId, invite, timeoutMs: 45_000 });
      // Persist the SHARED mesh key so a restart re-binds to the founder's mesh (not a fresh fork).
      meta.bootstrapKey = graph.autobaseKey;
      await bringMeshOnline(meshId, graph, meta);
      saveMeshRecords();
      return meshId;
    } catch (err) {
      // A failed FIRST join leaves a half-written root store; if nothing else lives on the host,
      // discard it so the next boot doesn't FOUND a lone primary (the host owns the injected store).
      if (isPrimary && runtimes.size === 0) {
        try { await h.close(); } catch { /* best effort */ }
        host = null;
        try { rmSync(MESH_STORE_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
      }
      throw err;
    }
  };

  /** Sync summary of every membership (private compute + public cells) for the dashboard. */
  const meshSummaries = (): MeshSummary[] => [
    ...[...runtimes.entries()].map(([meshId, m]) => {
      const meta = meshMeta.get(meshId);
      return { meshId, label: meta?.label ?? meshId, visibility: meta?.visibility ?? "private", tier: meta?.tier ?? 0, peers: m.pool.peers().length, writable: m.graph.writable, creator: meta?.creator === true };
    }),
    ...[...publicMeshes.values()].map((p) => ({ meshId: p.cellId, label: p.label, visibility: "public", tier: 99, peers: Math.max(0, p.mesh.knownFeeds().length - 1), writable: true, creator: false })),
  ];

  /**
   * Join a public, discoverable cell (spec §9 / B): a leaderless gossip mesh on its OWN per-cell
   * seeded store (identity unlinkable to the private mesh) + mDNS feed discovery (no pairing). Kept
   * out of `runtimes` so it never touches compute/firewall/delegation — broadcast-only by construction.
   */
  const joinPublicCell = async (cellId: string, label: string): Promise<void> => {
    if (publicMeshes.has(cellId)) return;
    const storeDir = join(HYPHA_DATA_DIR, "public", cellId.replace(/[^a-zA-Z0-9_-]/g, "_"));
    const m = await PublicMesh.open({ storeDir, cellId, masterSeed: seed, audit });
    const discovery = startCellDiscovery(cellId, m.feedKey, HYPHA_PAIR_PORT, (feedKey) => m.addPeerFeed(feedKey));
    publicMeshes.set(cellId, { cellId, label, mesh: m, discovery });
    meshMeta.set(cellId, { meshId: cellId, label, visibility: "public", reach: "local", tier: 99 });
    saveMeshRecords();
    console.log(`📣 public cell "${label}" (${cellId}) — gossiping as feed ${m.feedKey.slice(0, 16)}…`);
  };

  const meshController: MeshController = {
    displayName: () => DEVICE_NAME,
    inMesh: () => mesh !== null,
    localKey: async () => {
      if (mesh) return mesh.graph.localWriterKey;
      if (host) return host.prospectiveWriterKey(PRIMARY_MESH_ID);
      return MeshGraph.prospectiveWriterKey(MESH_STORE_DIR);
    },
    pairedDeviceKeys: async () => {
      if (!mesh) return new Set<string>();
      const self = mesh.graph.localWriterKey;
      return new Set((await mesh.graph.capabilities()).map((c) => c.deviceId).filter((k) => k !== self));
    },
    hostInvite: async (initiatorKey, target) => {
      // Resolve which mesh to admit the joiner into: a brand-new one, a chosen existing one, or primary.
      let m: MeshRuntime;
      let meshLabel: string;
      if (target?.newMeshLabel) {
        const meshId = await foundMesh(target.newMeshLabel);
        m = runtimes.get(meshId)!;
        meshLabel = target.newMeshLabel;
      } else if (target?.meshId && runtimes.has(target.meshId)) {
        m = runtimes.get(target.meshId)!;
        meshLabel = meshMeta.get(target.meshId)?.label ?? "Mesh";
      } else {
        m = await ensureMeshOnline();
        meshLabel = meshMeta.get(PRIMARY_MESH_ID)?.label ?? "Primary";
      }
      // A host must be able to APPEND the add-writer record. Minting an invite from a non-writable
      // mesh accepts the PIN and then strands the joiner (the silent-stuck failure) — fail loud here.
      if (!(await ensureWritable(m))) {
        throw new Error("this mesh isn't writable (still syncing, or its peers are gone) — it can't admit a new device right now; if this mesh is dead, Reset it and pair fresh");
      }
      // (Re)pairing un-tombstones the device so a previously-disconnected peer can return.
      if (forgotten.delete(initiatorKey)) saveForgotten();
      m.graph.allow(initiatorKey);
      // Stamp the ack NOW (sync) so any stale active:true record that replicates in later can't
      // re-tombstone the device we're re-pairing; then best-effort retract the unpair mesh-wide.
      stampUnpairAck(m.graph.localWriterKey, initiatorKey);
      void (async () => {
        if (!(await ensureWritable(m))) return;
        await m.graph.unpair(m.graph.localWriterKey, initiatorKey, false).catch((err) => {
          audit.record({ event: "note", extra: { role: "mesh", phase: "unpair-retract-failed", initiatorKey, error: String(err) } });
        });
      })();
      return { invite: await m.graph.mintInvite(), meshLabel };
    },
    joinWith: async (invite, label) => {
      await joinAsMembership(invite, label || "Mesh");
    },
  };

  /**
   * Forget one peer. Local effects (firewall + warm pool) always apply. Mesh-wide effects
   * (delete its capability, revoke its writer) need write access — a device still syncing
   * after reopen isn't writable yet, so we try to gain it, and skip (not crash) if we can't.
   * Returns whether the mesh-wide removal stuck.
   */
  /**
   * A reopened paired device starts non-writable and regains write access once it re-syncs
   * the host's add-writer record. Poll update() briefly (as the pairing smoke does) rather
   * than failing on the first check.
   */
  /**
   * Backfill `bootstrapKey` for a mesh whose meshes.json record predates the resilience fix — the key is
   * recorded at join time, so memberships paired earlier lack it and would FORK on the next restart.
   * Once the device is correctly writable in the mesh, record the current autobase key so the next
   * restart RE-BINDS. Safe for both roles (verified live): an EDGE records the shared (founder's) key and
   * re-binds to it; a FOUNDER records its own autobase key, and reopening with it recovers the same mesh
   * writable (Autobase(store, ownKey) ≡ Autobase(store, null)). One-shot per mesh.
   */
  const backfillBootstrapKey = (m: MeshRuntime): void => {
    const meta = meshMeta.get(m.meshId);
    if (!meta || meta.bootstrapKey || meta.visibility === "public") return;
    meta.bootstrapKey = m.graph.autobaseKey;
    meshMeta.set(m.meshId, meta);
    saveMeshRecords();
    audit.record({ event: "note", extra: { role: "mesh", phase: "bootstrapKey-backfill", meshId: m.meshId, key: m.graph.autobaseKey.slice(0, 8) } });
  };

  const ensureWritable = async (m: MeshRuntime, timeoutMs = 6000): Promise<boolean> => {
    const t0 = Date.now();
    while (!m.graph.writable && Date.now() - t0 < timeoutMs) {
      await m.graph.update().catch(() => undefined);
      if (m.graph.writable) break;
      await sleep(300);
    }
    if (m.graph.writable) backfillBootstrapKey(m);
    return m.graph.writable;
  };

  /**
   * Best-effort CRDT propagation of a disconnect (unpair record + forget cap + revoke writer).
   * The unpair record is the MUTUAL half: it replicates to the peer, whose reconcile tombstones
   * us back — so a disconnect disconnects on BOTH ends, not just here. Never throws.
   */
  const propagateForget = async (m: MeshRuntime, deviceKey: string): Promise<void> => {
    if (!(await ensureWritable(m))) return;
    try {
      await m.graph.unpair(m.graph.localWriterKey, deviceKey, true);
      await m.graph.forgetCapability(deviceKey);
      await m.graph.removeWriter(deviceKey);
    } catch (err) {
      audit.record({ event: "note", extra: { role: "mesh", phase: "propagate-forget-failed", deviceKey, error: String(err) } });
    }
  };

  /**
   * HARD disconnect on THIS device — always succeeds, needs no writability or peer sync:
   * tombstone the device (hidden + never served + never borrowed), drop it from the firewall
   * allow-list, and reconcile firewall + warm pool immediately. CRDT removal runs in the
   * background on top (so it also disappears for others when we're a writer), but the local
   * tombstone is authoritative — "Disconnect" disconnects, period.
   */
  const hardDisconnect = async (m: MeshRuntime, deviceKey: string, consumerPublicKey?: string): Promise<void> => {
    forgotten.add(deviceKey);
    saveForgotten();
    if (consumerPublicKey) m.graph.disallow(consumerPublicKey);
    await m.reconcileFirewall().catch(() => undefined);
    await m.pool.reconcile().catch(() => undefined);
    void propagateForget(m, deviceKey);
  };

  const meshControl: MeshControl = {
    forgetPeer: async (deviceKey) => {
      try {
        const m = mesh;
        if (!m) return { ok: false, error: "this device isn't in a mesh yet" };
        if (!deviceKey) return { ok: false, error: "deviceKey required" };
        if (deviceKey === m.graph.localWriterKey) return { ok: false, error: "can't disconnect this device from itself" };
        const cap = (await m.graph.capabilities().catch(() => [])).find((c) => c.deviceId === deviceKey);
        await hardDisconnect(m, deviceKey, cap?.consumerPublicKey);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
    forgetStale: async () => {
      try {
        const m = mesh;
        if (!m) return { ok: false, count: 0, error: "this device isn't in a mesh yet" };
        const self = m.graph.localWriterKey;
        const now = Date.now();
        const stale = (await m.graph.capabilities().catch(() => [])).filter(
          (c) => c.deviceId !== self && !forgotten.has(c.deviceId) && now - Date.parse(c.lastSeen) > STALE_MS,
        );
        for (const c of stale) await hardDisconnect(m, c.deviceId, c.consumerPublicKey);
        return { ok: true, count: stale.length };
      } catch (err) {
        return { ok: false, count: 0, error: String(err) };
      }
    },
    restorePeer: async (deviceKey) => {
      try {
        if (!deviceKey) return { ok: false, error: "deviceKey required" };
        if (!forgotten.has(deviceKey)) return { ok: false, error: "that device isn't disconnected" };
        forgotten.delete(deviceKey);
        saveForgotten();
        const m = mesh;
        if (m) {
          // Ack first (sync) so a stale active:true can't instantly re-tombstone; then
          // best-effort retract the unpair mesh-wide and re-admit the peer locally.
          stampUnpairAck(m.graph.localWriterKey, deviceKey);
          void (async () => {
            if (!(await ensureWritable(m))) return;
            await m.graph.unpair(m.graph.localWriterKey, deviceKey, false).catch((err) => {
              audit.record({ event: "note", extra: { role: "mesh", phase: "unpair-retract-failed", deviceKey, error: String(err) } });
            });
            // Reverse the `removeWriter` that `forgetPeer` did — otherwise the peer stays
            // `writable:false` forever and "Restore" can't actually undo "Disconnect".
            await m.graph.addWriter(deviceKey).catch((err) => {
              audit.record({ event: "note", extra: { role: "mesh", phase: "re-add-writer-failed", deviceKey, error: String(err) } });
            });
          })();
          await m.reconcileFirewall().catch(() => undefined);
          await m.pool.reconcile().catch(() => undefined);
        }
        audit.record({ event: "pairing", extra: { role: "mesh", phase: "restore", deviceKey } });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
    meshInfo: () => ({
      writable: mesh ? mesh.graph.writable : null,
      meshId: mesh ? mesh.graph.autobaseKey.slice(0, 8) : null,
      forgotten: [...forgotten],
      meshes: meshSummaries(),
    }),
    listMeshes: async () => meshSummaries(),
    newMesh: async (label) => {
      try { return { ok: true, meshId: await foundMesh(label || "Mesh") }; }
      catch (err) { return { ok: false, error: String(err) }; }
    },
    inviteToMesh: async (meshId) => {
      try {
        const m = runtimes.get(meshId);
        if (!m) return { ok: false, error: "no such mesh on this device" };
        if (!(await ensureWritable(m))) return { ok: false, error: "mesh not writable yet — try again in a moment" };
        return { ok: true, invite: await m.graph.mintInvite() };
      } catch (err) { return { ok: false, error: String(err) }; }
    },
    joinMesh: async (invite, label) => {
      try {
        if (!invite) return { ok: false, error: "invite required" };
        return { ok: true, meshId: await joinAsMembership(invite, label || "Mesh") };
      } catch (err) { return { ok: false, error: String(err) }; }
    },
    joinPublicCell: async (cellId, label) => {
      try {
        if (!cellId) return { ok: false, error: "cellId required" };
        await joinPublicCell(cellId, label || "Public cell");
        return { ok: true, meshId: cellId };
      } catch (err) { return { ok: false, error: String(err) }; }
    },
    deleteMesh: async (meshId) => {
      if (meshId === PRIMARY_MESH_ID) return { ok: false, error: "the primary mesh can't be deleted" };
      const meta = meshMeta.get(meshId);
      if (!meta) return { ok: false, error: "no such mesh on this device" };
      if (meta.creator !== true) return { ok: false, error: "only the mesh's creator can delete it" };
      try {
        const rt = runtimes.get(meshId);
        if (rt) { await rt.stop(); runtimes.delete(meshId); }
        meshMeta.delete(meshId);
        saveMeshRecords();
        audit.record({ event: "note", extra: { role: "mesh-services", meshId, phase: "mesh-deleted" } });
        return { ok: true };
      } catch (err) { return { ok: false, error: String(err) }; }
    },
    leaveMesh: async (meshId) => {
      // Leave a mesh THIS device joined: drop only our own membership (stop the runtime + remove the
      // record so boot won't reopen it). No creator gate — unlike deleteMesh, anyone can leave; the mesh
      // lives on for its other members. The primary mesh is identity-anchoring and never leavable.
      if (meshId === PRIMARY_MESH_ID) return { ok: false, error: "the primary mesh can't be left" };
      const meta = meshMeta.get(meshId);
      if (!meta) return { ok: false, error: "no such mesh on this device" };
      try {
        const rt = runtimes.get(meshId);
        if (rt) { await rt.stop(); runtimes.delete(meshId); }
        meshMeta.delete(meshId);
        saveMeshRecords();
        audit.record({ event: "note", extra: { role: "mesh-services", meshId, phase: "mesh-left" } });
        return { ok: true };
      } catch (err) { return { ok: false, error: String(err) }; }
    },
    receipts: async () => {
      const all = await Promise.all([...runtimes.values()].map((m) => m.graph.receipts().catch(() => [])));
      return all.flat();
    },
  };

  const pairing = new PairingController(meshController, audit);

  // KV-cache sessions: consumer-side ledger for the shim's delegated completions, plus a
  // janitor for THIS device's provider-side `shim.*` cache dirs (peers' sessions on us —
  // consumer-side deleteCache doesn't cross the delegation boundary, so every device
  // sweeps its own disk). Hourly, unref'd; one sweep at boot clears prior runs' orphans.
  const kv = HYPHA_KV_CACHE ? new KvSessions(HYPHA_KV_MAX_SESSIONS) : undefined;
  const sweep = (): void => {
    const removed = sweepKvCacheDir(HYPHA_KV_DIR, HYPHA_KV_TTL_MS);
    if (removed > 0) audit.record({ event: "note", extra: { role: "kv-janitor", removed, dir: HYPHA_KV_DIR } });
  };
  sweep();
  const janitor = setInterval(sweep, 60 * 60 * 1000);
  janitor.unref();

  // The delegation ladder (spec §6) over every membership's warm pool, tagged with tier/visibility.
  const router = new MeshRouter(() =>
    [...runtimes.entries()].map(([meshId, m]) => {
      const meta = meshMeta.get(meshId);
      return { meshId, label: meta?.label ?? meshId, tier: meta?.tier ?? 0, visibility: meta?.visibility ?? "private", selfWriterKey: m.graph.localWriterKey, pool: m.pool };
    }),
  );
  const server = createShim({
    getRouter: () => router,
    getSelfConsumerKey: () => provider.selfKey,
    inflight,
    port: HYPHA_PORT,
    pairing,
    mesh: meshControl,
    audit,
    ...(kv ? { kv } : {}),
    settlement,
    paymentControl,
    forward: forwardClient,
    recordObservation: (providerId, ok, ttftMs) => reputation.recordObservation({ providerId, ok, ...(ttftMs ? { ttftMs } : {}) }),
    getReputation: () => reputation.snapshot(),
    getShareModels: () => shareModels,
    setShareModels,
    getUnsharedModels: () => [...unsharedModels],
    setAliasShared,
  });

  // Feed reputation from the replicated settled receipts (read-only snapshot, refreshed on a tick).
  // Phase 4: also refresh the wallet↔key BINDING set from peers' caps — verify each `identityProof`
  // signature recovers to its advertised payee, so unbound providers are floored. `setReceipts` is
  // awaited because it runs the on-chain verification (cached by txHash) when verifyReceipts is on; a
  // re-entrancy guard keeps a slow tick from overlapping the next.
  let repBusy = false;
  const refreshReputation = async (): Promise<void> => {
    if (repBusy) return;
    repBusy = true;
    try {
      if (verifyReceipts) {
        const caps = (await Promise.all([...runtimes.values()].map((m) => m.graph.capabilities().catch(() => [])))).flat();
        for (const c of caps) {
          if (!c.providerPublicKey) continue;
          const wallet = c.settlement?.recipient;
          if (wallet && verifyIdentityProof(c.identityProof, c.providerPublicKey, wallet)) boundProviders.set(c.providerPublicKey, wallet);
          else boundProviders.delete(c.providerPublicKey);
        }
      }
      const all = await Promise.all([...runtimes.values()].map((m) => m.graph.receipts().catch(() => [])));
      await reputation.setReceipts(all.flat());
    } catch { /* best effort — reputation is advisory */ } finally {
      repBusy = false;
    }
  };
  const repTimer = setInterval(() => void refreshReputation(), 15_000);
  repTimer.unref();

  // Consumer connectivity self-heal (HYPHA_RESILIENT_RECONNECT, default OFF → not started). A clean
  // provider restart already self-heals via the SDK's per-RPC reconnect; this catches the whole
  // transport going stale at once — the device SLEPT (wall-clock gap) or ROAMED (every provider
  // unreachable in a tick) — by tearing down + rebuilding the SDK swarm (suspend()+resume()) and
  // re-warming. Pure decision in `decideHeal` (smoke:reconnect); this only wires the effects.
  if (HYPHA_RESILIENT_RECONNECT) {
    const connectivity = new ConnectivityManager(
      {
        liveProviders: () => [...new Set([...runtimes.values()].flatMap((m) => m.pool.livePeerKeys()))],
        probe: (key) =>
          heartbeat({ delegate: { providerPublicKey: key, timeout: HYPHA_RECONNECT_PROBE_TIMEOUT_MS } })
            .then(() => true)
            .catch(() => false),
        resetTransport: async () => {
          await suspend();
          await new Promise((r) => setTimeout(r, 600));
          await resume();
        },
        rewarm: async () => {
          await Promise.all([...runtimes.values()].map((m) => m.pool.rewarmAll().catch(() => undefined)));
        },
        now: () => Date.now(),
        audit,
      },
      {
        enabled: true,
        intervalMs: HYPHA_RECONNECT_INTERVAL_MS,
        wakeGapMs: HYPHA_RECONNECT_WAKE_GAP_MS,
        healCooldownMs: HYPHA_RECONNECT_HEAL_COOLDOWN_MS,
        allFailThreshold: HYPHA_RECONNECT_ALLFAIL_THRESHOLD,
      },
    );
    connectivity.start();
  }

  // Established device: rejoin every membership at boot. A pre-multi-mesh device (mesh-store exists,
  // no meshes.json) → migrate it as PRIMARY (its writer key + data survive on the default namespace).
  // Fresh device: stay mesh-less until it pairs / founds.
  {
    const records = loadMeshRecords();
    if (records.length === 0 && existsSync(MESH_STORE_DIR)) records.push(primaryRecord());
    for (const rec of records) meshMeta.set(rec.meshId, rec);
    if (records.length > 0) {
      for (const rec of records) {
        try {
          if (rec.visibility === "public") {
            await joinPublicCell(rec.meshId, rec.label);
          } else {
            const h = await ensureHost();
            const { graph } = await h.openMesh({ meshId: rec.meshId, ...(rec.bootstrapKey ? { bootstrapKey: Buffer.from(rec.bootstrapKey, "hex") } : {}) });
            await bringMeshOnline(rec.meshId, graph, rec);
          }
        } catch (err) {
          console.error(`⚠️ failed to reopen mesh "${rec.label}" (${rec.meshId.slice(0, 8)}):`, err);
        }
      }
      saveMeshRecords();
      console.log(`🍄 Hypha "${DEVICE_NAME}" — ${runtimes.size} private + ${publicMeshes.size} public mesh(es) online${forgotten.size ? ` (${forgotten.size} tombstoned)` : ""}.`);
      const pm = runtimes.get(PRIMARY_MESH_ID);
      if (pm) void ensureWritable(pm).then((w) => console.log(w ? "✍️  primary writable (can manage the mesh)" : "⏳ primary not writable yet — will retry when needed"));
    } else {
      console.log(`🍄 Hypha "${DEVICE_NAME}" — not in a mesh yet. Leash → Services → Mesh → "Add a device" / "New mesh".`);
    }
  }

  server.listen(HYPHA_PORT, "127.0.0.1", () => {
    console.log(`🔌 control/shim on :${HYPHA_PORT} · LAN pairing on :${HYPHA_PAIR_PORT} (open only while pairing)`);
    if (settlement.online()) console.log("💸 settlement enabled for delegated compute (Plasma first, Solana fallback)");
    console.log("✅ Hypha ready. Ctrl-C to stop.");
  });

  const quit = (): void => {
    void (async () => {
      audit.record({ event: "note", extra: { role: "hypha", stopped: true } });
      adapterSync?.stop();
      providerEconomy?.stop();
      await pairing.cancel();
      for (const m of runtimes.values()) await m.stop();
      for (const p of publicMeshes.values()) { p.discovery.stop(); await p.mesh.close().catch(() => undefined); }
      server.close();
      await paymentControl.close().catch(() => undefined);
      await paymentControlServer?.close().catch(() => undefined);
      await forwardClient?.close().catch(() => undefined);
      await forwardServer?.close().catch(() => undefined);
      try {
        await stopQVACProvider();
      } catch {
        /* already down */
      }
      if (host) await host.close();
      void close();
      console.log("\n🛑 Hypha stopped");
      process.exit(0);
    })();
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  process.stdin.resume();
}

try {
  const cmd = process.argv[2];
  if (cmd === "invite") await runInvite();
  else if (cmd === "pair") await runPair(process.argv[3]);
  else await runDaemon();
} catch (err) {
  console.error("❌ hypha failed:", err);
  audit.record({ event: "note", extra: { role: "hypha", error: String(err) } });
  process.exit(1);
}
