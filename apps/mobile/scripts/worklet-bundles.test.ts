import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const mobileRoot = resolve(dirname(import.meta.filename), "..");

for (const name of ["mesh-worklet", "forward-worklet", "public-forward-worklet"]) {
  const androidBundle = readFileSync(`${mobileRoot}/worklets/${name}.android.bundle.js`, "utf8");
  assert.match(androidBundle, /linked:lib[^"\\]+\.so/, `${name} must resolve Android shared-object addons`);
  assert.doesNotMatch(androidBundle, /linked:[^"\\]+\.framework\//, `${name} must not resolve iOS frameworks on Android`);
}

for (const bridge of ["meshClient.ts", "forwardWorklet.ts", "publicCompute.ts"]) {
  const source = readFileSync(`${mobileRoot}/${bridge}`, "utf8");
  assert.match(source, /Platform\.OS === "android"/, `${bridge} must select its Android-targeted worklet bundle`);
}

const publicBridge = readFileSync(`${mobileRoot}/publicCompute.ts`, "utf8");
assert.ok(
  publicBridge.indexOf('ipc.on("data"') < publicBridge.indexOf('worklet.start("/public-forward.bundle"'),
  "public compute must subscribe to IPC before starting its one-shot-ready worklet",
);

console.log("worklet-bundles.test.ts: ok");
