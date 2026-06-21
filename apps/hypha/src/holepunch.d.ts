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
declare module "@hyperswarm/secret-stream" {
  export default class SecretStream {
    constructor(initiator: boolean, rawStream: unknown, opts?: { keyPair?: { publicKey: Buffer; secretKey: Buffer }; remotePublicKey?: Buffer });
    readonly remotePublicKey?: Buffer;
    on(event: string, listener: (...args: any[]) => void): this;
    write(data: string | Buffer): boolean;
    destroy(error?: Error): void;
  }
}
