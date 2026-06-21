import assert from "node:assert/strict";
import { meshMetaPath, readMeshMeta, writeMeshMeta } from "../worklets/mesh-persistence.mjs";

assert.equal(meshMetaPath("/app/files/mesh-store"), "/app/files/mesh-store.meta.json");

const files = new Map<string, Uint8Array>();
const fs = {
  readFileSync(path: string) {
    const value = files.get(path);
    if (!value) throw new Error("missing");
    return value;
  },
  writeFileSync(path: string, value: Uint8Array) {
    files.set(path, value);
  },
};
const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);

assert.equal(writeMeshMeta({ fs, storeDir: "/app/files/mesh-store", encode, meta: { joined: true } }), true);
assert.deepEqual(readMeshMeta({ fs, storeDir: "/app/files/mesh-store", decode }), { joined: true });

let surfaced = "";
assert.equal(
  writeMeshMeta({
    fs: { ...fs, writeFileSync() { throw new Error("disk full"); } },
    storeDir: "/app/files/mesh-store",
    encode,
    meta: { joined: true },
    onError: (error: unknown) => { surfaced = error instanceof Error ? error.message : String(error); },
  }),
  false,
);
assert.equal(surfaced, "disk full");

console.log("mesh-persistence.test.ts: ok");
