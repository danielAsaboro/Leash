import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const mobileRoot = resolve(dirname(import.meta.filename), "..");

for (const name of ["mesh-worklet", "forward-worklet"]) {
  const androidBundle = readFileSync(`${mobileRoot}/worklets/${name}.android.bundle.js`, "utf8");
  assert.match(androidBundle, /linked:lib[^"\\]+\.so/, `${name} must resolve Android shared-object addons`);
  assert.doesNotMatch(androidBundle, /linked:[^"\\]+\.framework\//, `${name} must not resolve iOS frameworks on Android`);
}

for (const bridge of ["meshClient.ts", "forwardWorklet.ts"]) {
  const source = readFileSync(`${mobileRoot}/${bridge}`, "utf8");
  assert.match(source, /Platform\.OS === "android"/, `${bridge} must select its Android-targeted worklet bundle`);
}

console.log("worklet-bundles.test.ts: ok");
