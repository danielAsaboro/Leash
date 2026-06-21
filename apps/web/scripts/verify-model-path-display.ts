import assert from "node:assert/strict";
import { displayPathMiddle } from "../lib/leash/path-display.ts";

assert.equal(displayPathMiddle("/Users/cartel/models", 8, 8), "/Users/cartel/models", "short paths stay intact");
assert.equal(
  displayPathMiddle("/Volumes/Development/LeashData/device-mqo5sac1/models", 12, 18),
  "/Volumes/Dev…ce-mqo5sac1/models",
  "long paths collapse in the middle",
);

console.log("verify-model-path-display: ok");
