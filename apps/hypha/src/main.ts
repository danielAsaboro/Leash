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
import { close, stopQVACProvider } from "@qvac/sdk";
import { AuditLog, KvSessions, sweepKvCacheDir } from "@mycelium/shared";
import { MeshGraph, unpairKey, startAdapterSync, type AdapterSyncHandle } from "@mycelium/mesh";
import { DEVICE_NAME, FORGOTTEN_FILE, HYPHA_KV_CACHE, HYPHA_KV_DIR, HYPHA_KV_MAX_SESSIONS, HYPHA_KV_TTL_MS, HYPHA_PAIR_PORT, HYPHA_PORT, INVITE_FILE, LOG_DIR, MESH_STORE_DIR, STALE_MS, UNPAIR_ACK_FILE, loadOrCreateSeed } from "./config.ts";
import { startMeshServices, type MeshRuntime } from "./mesh-services.ts";
import { PairingController, type MeshController } from "./pairing.ts";
import { createShim, type Inflight, type MeshControl } from "./shim.ts";

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
  const seed = loadOrCreateSeed();
  const inflight = makeInflight();
  let mesh: MeshRuntime | null = null;
  // Layer-4: share trained LoRA adapters over THIS mesh (publish local promotable ones,
  // fetch peers' newer ones). Started once the mesh is online; rides the same swarm.
  let adapterSync: AdapterSyncHandle | null = null;

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

  const openOrFoundGraph = async (): Promise<MeshGraph> => {
    const g = await MeshGraph.open({ storeDir: MESH_STORE_DIR, audit });
    await g.joinSwarm();
    return g;
  };

  /** Every mesh-online path goes through here: start services, wire + run the unpair reconcile. */
  const bringMeshOnline = async (g: MeshGraph): Promise<MeshRuntime> => {
    const m = await startMeshServices(g, seed, inflight, audit, isForgotten);
    g.onChange(() => void reconcileUnpairs(m));
    void reconcileUnpairs(m);
    adapterSync ??= startAdapterSync(g, { audit }); // Layer-4 adapter distribution over this mesh
    return m;
  };

  /**
   * Lazy mesh bring-up, SERIALIZED. The first PIN confirm on a fresh host FOUNDS the mesh
   * (store open + swarm + provider — seconds); a retried confirm racing it would call
   * MeshGraph.open on the same corestore dir and die with rocksdb's "lock hold by current
   * process". All callers share the single in-flight open instead.
   */
  let meshOpening: Promise<MeshRuntime> | null = null;
  const ensureMeshOnline = (): Promise<MeshRuntime> => {
    if (mesh) return Promise.resolve(mesh);
    meshOpening ??= (async () => {
      try {
        const g = await openOrFoundGraph();
        const m = await bringMeshOnline(g);
        mesh = m;
        return m;
      } finally {
        meshOpening = null;
      }
    })();
    return meshOpening;
  };

  const meshController: MeshController = {
    displayName: () => DEVICE_NAME,
    inMesh: () => mesh !== null,
    localKey: async () => (mesh ? mesh.graph.localWriterKey : await MeshGraph.prospectiveWriterKey(MESH_STORE_DIR)),
    pairedDeviceKeys: async () => {
      if (!mesh) return new Set<string>();
      const self = mesh.graph.localWriterKey;
      return new Set((await mesh.graph.capabilities()).map((c) => c.deviceId).filter((k) => k !== self));
    },
    hostInvite: async (initiatorKey) => {
      const m = await ensureMeshOnline();
      // A host must be able to APPEND the add-writer record. Minting an invite from a
      // non-writable mesh accepts the PIN and then strands the joiner at the blind-pairing
      // step (the silent-stuck failure) — fail loud here so /pair/confirm returns the error.
      if (!(await ensureWritable(m))) {
        throw new Error("this device's mesh isn't writable (still syncing, or its peers are gone) — it can't admit a new device right now; if this mesh is dead, use Reset mesh here and pair fresh");
      }
      // (Re)pairing un-tombstones the device so a previously-disconnected peer can return.
      if (forgotten.delete(initiatorKey)) saveForgotten();
      m.graph.allow(initiatorKey);
      // Stamp the ack NOW (sync) so any stale active:true record that replicates in later
      // can't re-tombstone the device we're re-pairing; then best-effort append the LWW
      // retraction so the unpair clears mesh-wide (the peer's tombstone of us heals too).
      stampUnpairAck(m.graph.localWriterKey, initiatorKey);
      void (async () => {
        if (!(await ensureWritable(m))) return;
        await m.graph.unpair(m.graph.localWriterKey, initiatorKey, false).catch((err) => {
          audit.record({ event: "note", extra: { role: "mesh", phase: "unpair-retract-failed", initiatorKey, error: String(err) } });
        });
      })();
      return m.graph.mintInvite();
    },
    joinWith: async (invite) => {
      if (mesh) throw new Error("already in a mesh — pair from the other device");
      let g: MeshGraph;
      try {
        g = await MeshGraph.pair({ storeDir: MESH_STORE_DIR, invite, audit, timeoutMs: 45_000 });
      } catch (err) {
        // A failed join leaves a half-written prospective store; the next daemon boot would
        // FOUND a lone mesh from it (a mesh this device never asked for, with a key its peers
        // don't know). pair() already closed the store — remove the directory too.
        try {
          rmSync(MESH_STORE_DIR, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
        throw err;
      }
      mesh = await bringMeshOnline(g);
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
  const ensureWritable = async (m: MeshRuntime, timeoutMs = 6000): Promise<boolean> => {
    const t0 = Date.now();
    while (!m.graph.writable && Date.now() - t0 < timeoutMs) {
      await m.graph.update().catch(() => undefined);
      if (m.graph.writable) break;
      await sleep(300);
    }
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
    }),
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

  const server = createShim({ getPool: () => mesh?.pool ?? null, inflight, port: HYPHA_PORT, pairing, mesh: meshControl, audit, ...(kv ? { kv } : {}) });

  // Established device: rejoin its mesh at boot. Fresh device: stay unpaired until pairing.
  if (existsSync(MESH_STORE_DIR)) {
    const m = await ensureMeshOnline();
    console.log(`🍄 Hypha "${DEVICE_NAME}" — mesh online${forgotten.size ? ` (${forgotten.size} device(s) tombstoned)` : ""}.`);
    // Regain write access in the background (a reopened member is read-only until it re-syncs).
    void ensureWritable(m).then((w) => console.log(w ? "✍️  writable (can manage the mesh)" : "⏳ not a writer yet — will retry when needed"));
  } else {
    console.log(`🍄 Hypha "${DEVICE_NAME}" — not in a mesh yet. Leash → Services → Mesh → "Add a device" to pair.`);
  }

  server.listen(HYPHA_PORT, "127.0.0.1", () => {
    console.log(`🔌 control/shim on :${HYPHA_PORT} · LAN pairing on :${HYPHA_PAIR_PORT} (open only while pairing)`);
    console.log("✅ Hypha ready. Ctrl-C to stop.");
  });

  const quit = (): void => {
    void (async () => {
      audit.record({ event: "note", extra: { role: "hypha", stopped: true } });
      adapterSync?.stop();
      await pairing.cancel();
      if (mesh) await mesh.stop();
      server.close();
      try {
        await stopQVACProvider();
      } catch {
        /* already down */
      }
      if (mesh) await mesh.graph.close();
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
