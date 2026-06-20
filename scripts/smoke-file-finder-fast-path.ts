import assert from "node:assert/strict";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { fileFinderCommandForTask, fileFinderTokens, runFileFinderFastPath, shouldRunFileFinderFastPath } from "../apps/web/lib/leash/file-finder-fast-path.ts";

assert.deepEqual(fileFinderTokens("find where Leash MCP builtins are defined"), ["mcp", "builtins"], "generic query keeps only useful terms");
assert.equal(fileFinderCommandForTask("find it")?.includes("grep -RInE"), undefined, "empty retrieval query does not build bash");

const cmd = fileFinderCommandForTask("find where Leash MCP builtins are defined");
assert.ok(cmd, "file-finder builds a bash command for useful retrieval text");
assert.ok(cmd.includes("find ."), "command searches paths");
assert.ok(cmd.includes("grep -RInE"), "command searches content");
assert.ok(cmd.includes("-iname '*mcp*'"), "command includes tokenized filename predicate");
assert.ok(cmd.includes("mcp|builtins|mcp[-_ ]?builtins"), "command includes token and adjacent-pair content pattern");
assert.ok(!cmd.includes("rm "), "command is read-only retrieval");
assert.equal(shouldRunFileFinderFastPath("search my local files for MCP builtins"), true, "search tasks take the deterministic fast path");
assert.equal(shouldRunFileFinderFastPath("do not search files; say which tool file-finder uses"), false, "meta questions about the skill do not run retrieval");

let captured = "";
const registry: ToolSet = {
  bash: tool({
    description: "fake bash",
    inputSchema: z.object({ command: z.string() }),
    execute: async ({ command }) => {
      captured = command;
      return { text: "matching files by path:\n./apps/web/lib/leash/mcp-builtins.ts" };
    },
  }),
};

const result = await runFileFinderFastPath("find where Leash MCP builtins are defined", registry);
assert.equal(result?.text.includes("mcp-builtins.ts"), true, "fast path returns bash output");
assert.equal(result?.sources[0]?.title, "Skill · file-finder", "fast path preserves skill source");
assert.equal(captured.includes("grep -RInE"), true, "fast path executes generated retrieval command");

assert.equal(await runFileFinderFastPath("find where Leash MCP builtins are defined", {}), null, "fast path declines without bash");

console.log("✅ file-finder fast path — deterministic bash retrieval is wired and bounded");
