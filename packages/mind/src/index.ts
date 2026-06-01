/**
 * @mycelium/mind — Layer 3 (Mind): the router + tool-calling council that reasons
 * over the context graph. Built on the proven `@qvac/sdk` `completion({tools})`
 * surface (de-risked by the Days 1–3 spike).
 *
 * Step 2 lands the `search_graph` tool and proves the call/observe/answer loop
 * (see scripts/smoke-tool-call.ts). The council, critic, and router land in step 4.
 */
export { SEARCH_GRAPH_TOOL } from "./tools.ts";
