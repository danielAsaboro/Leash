/**
 * MeshHost (Layer 1 — Mesh): the device-level owner of MANY meshes.
 *
 * Spec: docs/superpowers/specs/2026-06-08-multi-mesh-membership-design.md §3.
 *
 * A device belongs to several meshes at once. The two things that CANNOT be per-mesh live
 * here:
 *   - ONE root Corestore — each mesh is a `rootStore.namespace(meshId)`. The legacy/primary
 *     mesh keeps the DEFAULT namespace (the root store itself), so its existing writer key —
 *     and the live pairing built on it — are preserved (§3.1 migration trap).
 *   - ONE shared Hyperswarm — joins N discovery keys; a single `rootStore.replicate(conn)`
 *     handler (registered once, here) covers every namespace at once.
 * Each mesh is a {@link MeshGraph} built against its namespace + this shared swarm.
 *
 * The device-global SDK provider + the UNION firewall (spec §4) live in the Hypha daemon,
 * NOT here — MeshHost is transport/storage only, and stays dependency-free of `@qvac/sdk`.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import Corestore from "corestore";
import Autobase from "autobase";
import Hyperswarm from "hyperswarm";
import b4a from "b4a";
import type { AuditLog } from "@mycelium/shared";
import { MeshGraph } from "./mesh-graph.ts";

/**
 * Reserved local meshId for the legacy/primary mesh. It is kept on the corestore DEFAULT
 * namespace (the root store) so a device upgrading from the single-mesh world reuses its
 * existing writer key and replicated data — the live mesh does not break (spec §3.1).
 */
export const PRIMARY_MESH_ID = "primary";

export interface MeshHostOptions {
  /** Root corestore directory (was the single `MESH_STORE_DIR`). */
  rootDir: string;
  /** Stand up a shared Hyperswarm (false for offline/loopback smokes — drive `replicate()` by hand). */
  swarm?: boolean;
  /** 64-hex seed → deterministic root primaryKey (repeatable demos/CI). Omit in normal use. */
  seed?: string;
  audit?: AuditLog;
}

export interface OpenMeshOptions {
  /** Local mesh handle (the namespace). Default = a fresh random id; `PRIMARY_MESH_ID` → default namespace. */
  meshId?: string;
  /** Pairing allow-list (private mesh). Empty/absent = open. */
  allowedDevices?: Set<string>;
  /** Existing autobase key to boot against (a reader of someone else's mesh, or an explicit re-bootstrap). */
  bootstrapKey?: Buffer | null;
}

export interface PairMeshOptions {
  /** Local mesh handle for the new membership. Default = a fresh random id. */
  meshId?: string;
  /** Hex blind-pairing invite minted by the host's mintInvite(). */
  invite: string;
  /** QR/session id paired with this invite. */
  inviteSessionId?: string;
  /** Allow-list to seed on the new membership (so it can in turn admit others). */
  allowedDevices?: Set<string>;
  timeoutMs?: number;
}

export class MeshHost {
  private readonly rootStore: Corestore;
  private readonly swarm: Hyperswarm | null;
  private readonly audit?: AuditLog;
  private readonly meshes = new Map<string, MeshGraph>();

  private constructor(rootStore: Corestore, swarm: Hyperswarm | null, audit?: AuditLog) {
    this.rootStore = rootStore;
    this.swarm = swarm;
    this.audit = audit;
  }

  /** Create the host: open the root corestore, stand up the shared swarm (unless `swarm:false`). */
  static async open(opts: MeshHostOptions): Promise<MeshHost> {
    mkdirSync(opts.rootDir, { recursive: true });
    // Mirror MeshGraph.makeStore: allowBackup disables the per-store rocksdb device-file lock
    // (safe — each device owns its own store; never opened twice). A seed pins the primaryKey.
    const storeOpts: { allowBackup: boolean; primaryKey?: Buffer; unsafe?: boolean } = { allowBackup: true };
    if (opts.seed) { storeOpts.primaryKey = b4a.from(opts.seed, "hex"); storeOpts.unsafe = true; }
    const rootStore = new Corestore(opts.rootDir, storeOpts);
    await rootStore.ready();
    let swarm: Hyperswarm | null = null;
    if (opts.swarm !== false) {
      swarm = new Hyperswarm();
      // Force localConnection:false on every dial. hyperdht's same-public-IP "LAN shortcut" pings the
      // peer's LAN address and ABORTS the whole connect if that ping fails — which silently breaks
      // RE-DIALS to a restarted peer inside the daemon, so a reopened edge device never re-syncs its
      // Autobase membership (it stays non-writable and the mesh shows 0 peers — the membership data is
      // on disk, the device just can't reconnect to re-confirm it). payment-control + forward-control
      // wrap this for the same reason; the normal holepunch connects in <1s. The swarm path is
      // daemon/cross-machine only — every same-machine mesh smoke uses `swarm:false`.
      const dht = (swarm as unknown as { dht?: { connect: (key: Buffer, o?: Record<string, unknown>) => unknown } }).dht;
      if (dht) {
        const origConnect = dht.connect.bind(dht);
        dht.connect = (key: Buffer, o?: Record<string, unknown>) => origConnect(key, { ...o, localConnection: false });
      }
      // ONE handler covers every mesh namespace (spec §3): replicate the ROOT store.
      swarm.on("connection", (rawConn, info) => {
        const conn = rawConn as { on(event: string, listener: (...args: unknown[]) => void): void };
        const remote = (info as { publicKey?: Buffer } | undefined)?.publicKey?.toString("hex").slice(0, 16) ?? "unknown";
        opts.audit?.record({ event: "note", extra: { role: "mesh-host", phase: "swarm-conn-open", remote } });
        conn.on("error", (err) => opts.audit?.record({ event: "note", extra: { role: "mesh-host", phase: "swarm-conn-error", remote, error: err instanceof Error ? err.message : String(err) } }));
        conn.on("close", () => opts.audit?.record({ event: "note", extra: { role: "mesh-host", phase: "swarm-conn-close", remote } }));
        rootStore.replicate(rawConn);
      });
    }
    opts.audit?.record({ event: "note", extra: { role: "mesh-host", phase: "open", rootDir: opts.rootDir, swarm: swarm !== null } });
    return new MeshHost(rootStore, swarm, opts.audit);
  }

  /** The corestore namespace for a meshId — PRIMARY keeps the default (root) store (§3.1). */
  private storeFor(meshId: string): Corestore {
    return meshId === PRIMARY_MESH_ID ? this.rootStore : this.rootStore.namespace(meshId);
  }

  /** Build the shared options every membership's MeshGraph gets (injected store/swarm/audit). */
  private graphOpts(meshId: string): { store: Corestore; sharedSwarm?: Hyperswarm; audit?: AuditLog } {
    return {
      store: this.storeFor(meshId),
      ...(this.swarm ? { sharedSwarm: this.swarm } : {}),
      ...(this.audit ? { audit: this.audit } : {}),
    };
  }

  /**
   * Open (or found) a mesh as a MeshGraph against its namespace + the shared swarm, and join
   * the swarm (if any). A fresh namespace founds a new mesh; passing `bootstrapKey` opens it as
   * a reader/member of an existing one; `PRIMARY_MESH_ID` recovers the legacy default-namespace mesh.
   */
  async openMesh(opts: OpenMeshOptions = {}): Promise<{ meshId: string; graph: MeshGraph }> {
    const meshId = opts.meshId ?? randomUUID();
    const existing = this.meshes.get(meshId);
    if (existing) return { meshId, graph: existing };
    const graph = await MeshGraph.open({
      ...this.graphOpts(meshId),
      ...(opts.bootstrapKey !== undefined ? { bootstrapKey: opts.bootstrapKey } : {}),
      ...(opts.allowedDevices ? { allowedDevices: opts.allowedDevices } : {}),
    });
    if (this.swarm) await graph.joinSwarm();
    this.meshes.set(meshId, graph);
    this.audit?.record({ event: "note", extra: { role: "mesh-host", phase: "open-mesh", meshId, autobaseKey: graph.autobaseKey.slice(0, 8) } });
    return { meshId, graph };
  }

  /**
   * Pair INTO an existing mesh (first-time join) as a NEW membership against a fresh namespace.
   * Unlike the single-mesh world, this does not require the device to be mesh-less — it just
   * adds another membership. The shared swarm is reused (no per-mesh swarm).
   */
  async pairMesh(opts: PairMeshOptions): Promise<{ meshId: string; graph: MeshGraph }> {
    const meshId = opts.meshId ?? randomUUID();
    if (this.meshes.has(meshId)) throw new Error(`mesh ${meshId} already open on this host`);
    const graph = await MeshGraph.pair({
      ...this.graphOpts(meshId),
      invite: opts.invite,
      ...(opts.inviteSessionId !== undefined ? { inviteSessionId: opts.inviteSessionId } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
    if (opts.allowedDevices) for (const k of opts.allowedDevices) graph.allow(k);
    this.meshes.set(meshId, graph);
    this.audit?.record({ event: "note", extra: { role: "mesh-host", phase: "pair-mesh", meshId, autobaseKey: graph.autobaseKey.slice(0, 8) } });
    return { meshId, graph };
  }

  /**
   * The writer key a mesh's namespace would use, computed WITHOUT opening its Autobase — so a
   * joiner can hand its key to a host before redeeming an invite (mirrors
   * MeshGraph.prospectiveWriterKey but on the host's shared root store, avoiding a second
   * Corestore on the same dir). Stable across calls (the namespace's local core key is persisted).
   */
  async prospectiveWriterKey(meshId: string): Promise<string> {
    const open = this.meshes.get(meshId);
    if (open) return open.localWriterKey;
    const localCore = Autobase.getLocalCore(this.storeFor(meshId));
    await localCore.ready();
    const key = b4a.toString(localCore.key, "hex");
    await localCore.close();
    return key;
  }

  get(meshId: string): MeshGraph | undefined { return this.meshes.get(meshId); }
  has(meshId: string): boolean { return this.meshes.has(meshId); }
  ids(): string[] { return [...this.meshes.keys()]; }
  all(): Array<{ meshId: string; graph: MeshGraph }> { return [...this.meshes.entries()].map(([meshId, graph]) => ({ meshId, graph })); }
  get size(): number { return this.meshes.size; }

  /**
   * Raw replication stream over the root store — for offline/loopback smokes (`swarm:false`):
   * `hostA.replicate(true)` piped to `hostB.replicate(false)` syncs every namespace at once,
   * exactly as the shared swarm's single connection handler would.
   */
  replicate(isInitiator: boolean): unknown {
    return this.rootStore.replicate(isInitiator);
  }

  /** Close ONE mesh (leave its topic, close its base). Leaves the shared swarm + root store intact. */
  async closeMesh(meshId: string): Promise<void> {
    const g = this.meshes.get(meshId);
    if (!g) return;
    await g.close();
    this.meshes.delete(meshId);
  }

  /** Tear down: close every mesh, then the shared swarm + root store. */
  async close(): Promise<void> {
    for (const g of this.meshes.values()) await g.close();
    this.meshes.clear();
    if (this.swarm) await this.swarm.destroy();
    await this.rootStore.close();
  }
}
