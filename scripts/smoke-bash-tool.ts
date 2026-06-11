/**
 * Runtime smoke for the Vercel `bash-tool` (just-bash) we wired into Brain → Tools as the
 * `files` route's sandboxed retrieval tools (`apps/web/lib/leash/bash-tools.ts`). The risk
 * isn't our glue (tsc covers that) — it's whether just-bash actually executes `grep`/`find`
 * in THIS Node runtime over a preloaded snapshot. This proves it end-to-end against a tiny
 * in-memory fileset, and that the toolkit exposes the three tools our `files` lane activates.
 *
 *   npm run smoke:bash
 */
import assert from "node:assert/strict";
import { createBashTool } from "bash-tool";

const { sandbox, tools } = await createBashTool({
  files: {
    "notes/journal.md": "Mood: good.\nThe passphrase is hummingbird-42.\n",
    "src/index.ts": "export const answer = 42;\n",
    "data/config.json": '{ "feature": "on", "limit": 7 }\n',
  },
});

// grep retrieves a value buried in the snapshot without anything being pasted into a prompt.
const grep = await sandbox.executeCommand("grep -rn passphrase .");
assert.equal(grep.exitCode, 0, "grep exits 0 on a match");
assert.ok(grep.stdout.includes("hummingbird-42"), "grep surfaced the value from notes/journal.md");

// find locates files by glob — the structural side of retrieval.
const find = await sandbox.executeCommand("find . -name '*.ts'");
assert.ok(find.stdout.includes("index.ts"), "find located the TypeScript file");

// cat reads a specific slice on demand.
const cat = await sandbox.executeCommand("cat data/config.json");
assert.ok(cat.stdout.includes('"limit": 7'), "cat read the json file");

// The toolkit exposes exactly the three tools our `files` lane activates (agent.ts BASH_TOOL_NAMES).
assert.deepEqual(Object.keys(tools).sort(), ["bash", "readFile", "writeFile"], "toolkit = bash/readFile/writeFile");

await (sandbox as unknown as { stop?: () => Promise<void> }).stop?.();
console.log("✅ bash-tool — just-bash runs here · grep/find/cat retrieve from the in-memory snapshot · tools = bash/readFile/writeFile — GO");
