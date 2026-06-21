import type { ToolSet } from "ai";

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

/** Execute an identical tool invocation at most once within one delegate run. */
export function memoizeToolExecutions(tools: ToolSet): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([toolName, definition]) => {
      if (!definition.execute) return [toolName, definition];
      const execute = definition.execute;
      const outcomes = new Map<string, Promise<unknown>>();
      return [
        toolName,
        {
          ...definition,
          execute: (input: unknown, options: Parameters<typeof execute>[1]) => {
            const key = JSON.stringify(stableValue(input));
            const prior = outcomes.get(key);
            if (prior) return prior;
            const outcome = Promise.resolve(execute(input, options));
            outcomes.set(key, outcome);
            return outcome;
          },
        },
      ];
    }),
  ) as ToolSet;
}
