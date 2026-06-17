/** tsx assertion script. Run: npx tsx apps/web/scripts/agent-mcp-refs.test.ts */
import assert from "node:assert";
import { grantedNames } from "../lib/leash/agent-grants.ts";

function main() {
  // grantedNames(serverToolNames, registryKeys, alreadyChosen, denied) → names to ADD
  const registry = new Set(["gh_pr", "gh_issue", "other"]);
  const out = grantedNames(["gh_pr", "gh_issue", "missing"], registry, new Set(["gh_pr"]), new Set(["gh_issue"]));
  assert.deepStrictEqual(out, [], "gh_pr already chosen, gh_issue denied, missing not in registry ⇒ none");
  const out2 = grantedNames(["gh_pr", "gh_issue"], registry, new Set(), new Set());
  assert.deepStrictEqual(out2.sort(), ["gh_issue", "gh_pr"], "both granted when in registry, not chosen, not denied");
  console.log("agent-mcp-refs: PASS");
}
main();
