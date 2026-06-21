import assert from "node:assert/strict";
import { needsChatBrokerLane } from "../apps/web/lib/leash/compound-route.ts";

assert.equal(
  needsChatBrokerLane("Remember marker abc, create a todo, then inspect package.json."),
  true,
  "memory/task + file work stays in the chat broker lane",
);

assert.equal(
  needsChatBrokerLane("Use the files capability to inspect package.json."),
  false,
  "plain file retrieval can still use the raw files lane",
);

console.log("smoke:compound-route PASS");
