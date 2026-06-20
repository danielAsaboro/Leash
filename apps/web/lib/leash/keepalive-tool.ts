import { tool, type ToolSet } from "ai";
import { z } from "zod";

export const KEEPALIVE_TOOL_NAME = "leash_keepalive";

export const KEEPALIVE_TOOL: ToolSet[string] = tool({
  description: "Compatibility sentinel only. Do not call this tool; answer directly in text.",
  inputSchema: z.object({ note: z.string().describe("A short note.") }),
  execute: async ({ note }) => ({ noted: note }),
});

export const KEEPALIVE_TOOLS: ToolSet = {
  [KEEPALIVE_TOOL_NAME]: KEEPALIVE_TOOL,
};
