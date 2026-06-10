/**
 * Ambient types for the Holepunch libraries Mycelium's mesh layer uses.
 *
 * autobase / blind-pairing / corestore / hyperbee / hyperswarm / b4a ship no (or
 * partial) `.d.ts`. Rather than `any`-cast at every call site, this single shim
 * types the exact surface MeshGraph touches — mirroring the packages/senses/src/
 * models.ts precedent (one seam absorbs the gap; the rest of the code stays strict).
 *
 * Verified against the installed sources (spike 05): autobase's `update()` takes NO
 * args; a plain Hyperbee has no `flush()` (put is durable on its own).
 */
declare module "corestore" {
  /**
   * A single Hypercore (append-only log). The mesh uses a SIBLING core ("adapter-feed")
   * to carry adapter BYTES — block 0 a manifest, blocks 1..N the gguf chunks — replicated
   * by the same corestore as the Autobase, while only a tiny pointer rides the CRDT
   * (Autobase = graph nodes only, hard constraint). `get({wait:false})` is the R6-bounded
   * read: returns null for a not-yet-replicated block instead of hanging.
   */
  export interface Hypercore {
    readonly key: Buffer;
    readonly length: number;
    readonly writable: boolean;
    ready(): Promise<void>;
    append(block: Buffer | Buffer[]): Promise<unknown>;
    get(index: number, opts?: { wait?: boolean; timeout?: number }): Promise<Buffer | null>;
    download(range?: { start?: number; end?: number; linear?: boolean }): unknown;
    /** Refresh this core's length from connected peers (a remote, replicating core learns its length here). */
    update(opts?: { wait?: boolean }): Promise<boolean>;
    close(): Promise<void>;
  }
  export default class Corestore {
    constructor(storage: string, opts?: { primaryKey?: Buffer; allowBackup?: boolean; unsafe?: boolean });
    ready(): Promise<void>;
    get(name: string | { name?: string; key?: Buffer }): Hypercore;
    /**
     * A namespaced view over the SAME underlying storage + replication: keys derive
     * deterministically from the root primaryKey + this name, so each mesh gets its own
     * Autobase/writer keys while one `rootStore.replicate(conn)` covers them all (spec §3).
     */
    namespace(name: string | Buffer): Corestore;
    replicate(connection: unknown): unknown;
    close(): Promise<void>;
  }
}
declare module "autobase" {
  export interface AutobaseNode<T = unknown> { value: T; from: { key: Buffer } }
  export interface ApplyHost {
    addWriter(key: Buffer, opts?: { indexer?: boolean }): Promise<void>;
    removeWriter(key: Buffer): Promise<void>;
  }
  export interface AutobaseOptions<T = unknown> {
    valueEncoding?: string;
    open(store: unknown): unknown;
    apply(nodes: Array<AutobaseNode<T>>, view: unknown, host: ApplyHost): Promise<void>;
  }
  export default class Autobase<T = unknown> {
    constructor(store: unknown, bootstrap: Buffer | null, opts: AutobaseOptions<T>);
    static getLocalCore(store: unknown): { key: Buffer; ready(): Promise<void>; close(): Promise<void> };
    readonly key: Buffer;
    readonly discoveryKey: Buffer;
    readonly local: { key: Buffer };
    readonly view: {
      put(key: string, value: unknown): Promise<void>;
      get(key: string): Promise<{ key: string; value: unknown } | null>;
      createReadStream(opts?: unknown): AsyncIterable<{ key: string; value: unknown }>;
    };
    readonly writable: boolean;
    ready(): Promise<void>;
    update(): Promise<void>;
    append(value: T): Promise<void>;
    replicate(connection: unknown): unknown;
    close(): Promise<void>;
    on(event: "update" | "writable" | "error", cb: (...args: unknown[]) => void): this;
    off(event: string, cb: (...args: unknown[]) => void): this;
  }
}
declare module "hyperbee" {
  export default class Hyperbee {
    constructor(core: unknown, opts?: { keyEncoding?: string; valueEncoding?: string });
    put(key: string, value: unknown): Promise<void>;
    del(key: string): Promise<void>;
    get(key: string): Promise<{ key: string; value: unknown } | null>;
    createReadStream(opts?: unknown): AsyncIterable<{ key: string; value: unknown }>;
  }
}
declare module "hyperswarm" {
  export default class Hyperswarm {
    constructor(opts?: { seed?: Buffer; bootstrap?: unknown[] });
    on(event: "connection", cb: (conn: unknown, info?: unknown) => void): this;
    join(topic: Buffer, opts?: { server?: boolean; client?: boolean }): unknown;
    /** Stop announcing/looking-up a topic. The MeshHost owns destroy(); a mesh only leaves its topic. */
    leave(topic: Buffer): Promise<void>;
    flush(): Promise<void>;
    destroy(): Promise<void>;
    readonly connections: Set<unknown>;
  }
}
declare module "blind-pairing" {
  export interface MemberRequest { open(publicKey: Buffer): Buffer; confirm(data: { key: Buffer; encryptionKey?: Buffer }): void; deny(opts?: { status?: number }): void; userData: Buffer }
  export interface Candidate { pairing: Promise<{ key: Buffer; encryptionKey?: Buffer }>; close(): Promise<void> }
  export interface Member { flushed(): Promise<void>; close(): Promise<void> }
  export default class BlindPairing {
    constructor(swarm: unknown, opts?: { poll?: number });
    static createInvite(key: Buffer, opts?: { data?: Buffer }): { id: Buffer; invite: Buffer; publicKey: Buffer; discoveryKey?: Buffer };
    addMember(opts: { discoveryKey: Buffer; onadd: (req: MemberRequest) => void | Promise<void> }): Member;
    addCandidate(opts: { invite: Buffer; userData: Buffer; onadd: (result: { key: Buffer }) => void | Promise<void> }): Candidate;
    close(): Promise<void>;
  }
}
declare module "b4a" {
  export function from(input: string | Buffer | Uint8Array, enc?: string): Buffer;
  export function toString(buf: Buffer | Uint8Array, enc?: string): string;
  export function equals(a: Buffer | Uint8Array, b: Buffer | Uint8Array): boolean;
  const _default: { from: typeof from; toString: typeof toString; equals: typeof equals };
  export default _default;
}
