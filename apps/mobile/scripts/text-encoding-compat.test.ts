import assert from "node:assert/strict";
import { encodeIntoCompat } from "../textEncodingCompat";

const encoder = new TextEncoder();

const ascii = new Uint8Array(5);
assert.deepEqual(encodeIntoCompat(encoder, "hello!", ascii), { read: 5, written: 5 });
assert.equal(new TextDecoder().decode(ascii), "hello");

const unicode = new Uint8Array(5);
assert.deepEqual(encodeIntoCompat(encoder, "A🌱B", unicode), { read: 3, written: 5 });
assert.equal(new TextDecoder().decode(unicode), "A🌱");

const noSplit = new Uint8Array(4);
assert.deepEqual(encodeIntoCompat(encoder, "A🌱", noSplit), { read: 1, written: 1 });
assert.equal(new TextDecoder().decode(noSplit.subarray(0, 1)), "A");

console.log("text-encoding-compat.test.ts: ok");
