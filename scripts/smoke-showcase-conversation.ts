import assert from "node:assert/strict";
import { buildShowcaseTurns } from "./showcase-multiorchestration-chat.ts";

const turns = buildShowcaseTurns({ marker: "showcase-test", fillerTurns: 4 });
const text = turns.map((turn) => turn.text).join("\n");

assert.ok(turns.length >= 10, "showcase has enough turns to exercise conversation continuity");
assert.ok(turns.some((turn) => turn.expect.includes("context_run")), "showcase includes context broker evidence");
assert.ok(turns.some((turn) => turn.expect.includes("memory_run")), "showcase includes memory broker evidence");
assert.ok(turns.some((turn) => turn.expect.includes("tasks_run")), "showcase includes task broker evidence");
assert.ok(turns.some((turn) => turn.expect.includes("agent__coder")), "showcase includes Grace/coder subagent evidence");
assert.ok(turns.some((turn) => turn.expect.includes("agent__summarizer")), "showcase includes Bree/summarizer subagent evidence");
assert.ok(/marker 7 followed marker 6/i.test(text), "showcase includes deterministic continuity marker filler turns");
assert.ok(!/LONG_CONTEXT_BLOCK/.test(text), "showcase avoids giant synthetic filler decodes");
assert.ok(/final continuity check/i.test(text), "showcase ends with a late continuity check");

console.log("smoke:showcase-conversation PASS");
