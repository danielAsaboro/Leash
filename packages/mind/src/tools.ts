/**
 * Tools the Mind layer exposes to its tool-calling models.
 *
 * The council's proposer is given exactly one tool: `search_graph`. When
 * answering needs private facts about the user (devices, projects, preferences,
 * notes, voice memos), the proposer emits a `search_graph` call; the orchestrator
 * runs it against the RAG index over the context graph (`@mycelium/senses`
 * `searchGraph`) and feeds the retrieved snippets back as a tool observation.
 */
import type { Tool } from "@qvac/sdk";

export const SEARCH_GRAPH_TOOL: Tool = {
  type: "function",
  name: "search_graph",
  description:
    "Search the user's private context graph (Apple Notes, files, and voice memos) for passages relevant to a query. Returns the most relevant source snippets, each tagged [Source N]. Call this whenever answering requires private facts about the user, their devices, projects, or preferences — do not guess from prior knowledge.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural-language description of the information needed from the graph.",
      },
      topK: {
        type: "integer",
        description: "How many source snippets to retrieve (default 3, max 8).",
      },
    },
    required: ["query"],
  },
};
