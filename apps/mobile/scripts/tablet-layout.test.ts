import assert from "node:assert/strict";
import { isTabletLayout, TABLET_MIN_WIDTH } from "../layout";

assert.equal(TABLET_MIN_WIDTH, 744);

assert.equal(isTabletLayout(390, 844), false, "iPhone portrait should use the phone shell");
assert.equal(isTabletLayout(430, 932), false, "large iPhone portrait should use the phone shell");
assert.equal(isTabletLayout(744, 1133), true, "iPad mini portrait should use the tablet shell");
assert.equal(isTabletLayout(1024, 1366), true, "iPad Pro portrait should use the tablet shell");
assert.equal(isTabletLayout(1180, 820), true, "iPad landscape should use the tablet shell");
assert.equal(isTabletLayout(700, 1133), false, "narrow split view should fall back to the phone shell");

console.log("tablet-layout smoke passed");
