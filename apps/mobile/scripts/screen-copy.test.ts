import assert from "node:assert/strict";
import { SCREEN_COPY } from "../screenCopy";

assert.deepEqual(SCREEN_COPY.home, { kicker: "Leash · Overview", title: "Home" });
assert.deepEqual(SCREEN_COPY.brain, { kicker: "Leash · Brain", title: "Brain" });
assert.deepEqual(SCREEN_COPY.activity, { kicker: "Leash · Activity", title: "Activity" });
assert.deepEqual(SCREEN_COPY.notifications, { kicker: "Leash · Proactive", title: "Notifications" });
assert.deepEqual(SCREEN_COPY.economy, { kicker: "Leash · Economy", title: "Ledger" });
assert.deepEqual(SCREEN_COPY.mesh, { kicker: "Mesh", title: "The Fabric" });
assert.deepEqual(SCREEN_COPY.services, { kicker: "Leash · Ops", title: "Services" });
assert.deepEqual(SCREEN_COPY.settings, { kicker: "Device & app", title: "Settings" });

console.log("screen-copy smoke passed");
