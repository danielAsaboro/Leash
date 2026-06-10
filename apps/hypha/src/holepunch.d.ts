declare module "hyperswarm" {
  export default class Hyperswarm {
    constructor(opts?: { seed?: Buffer; bootstrap?: unknown[] });
    on(event: "connection", cb: (conn: unknown, info?: unknown) => void): this;
    join(topic: Buffer, opts?: { server?: boolean; client?: boolean }): unknown;
    leave(topic: Buffer): Promise<void>;
    flush(): Promise<void>;
    destroy(): Promise<void>;
    readonly connections: Set<unknown>;
  }
}
