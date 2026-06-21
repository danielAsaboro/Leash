import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { patchBareKitJscArrayBuffer } = require("../plugins/with-android-jsc.js") as {
  patchBareKitJscArrayBuffer: (source: string) => string;
};

const source = `void read() {
    auto buffer = std::make_shared<BareKitBuffer>(len);

    std::copy(data, data + len, buffer->data());

    return ArrayBuffer(rt, buffer);
}`;

const patched = patchBareKitJscArrayBuffer(source);
assert.match(patched, /getPropertyAsFunction\(rt, "ArrayBuffer"\)/);
assert.match(patched, /array_buffer\.data\(rt\)/);
assert.doesNotMatch(patched, /ArrayBuffer\(rt, buffer\)/);
assert.equal(patchBareKitJscArrayBuffer(patched), patched, "BareKit patch must be idempotent");

console.log("android-jsc-plugin.test.ts: ok");
