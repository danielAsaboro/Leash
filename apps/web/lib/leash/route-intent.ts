import type { RouteIntent } from "./types.ts";

type Routable = { tier: "device" | "private" | "public" };

/**
 * Apply user route intent before the conductor ranks candidates. Explicit intents are strict:
 * absence yields an empty set and therefore a visible route failure. Automatic keeps every live
 * candidate so the conductor may choose a different eligible tier and report the route it used.
 */
export function optionsForRouteIntent<T extends Routable>(options: readonly T[], intent: RouteIntent): T[] {
  if (intent === "automatic") return [...options];
  const tier = intent === "local" ? "device" : intent;
  return options.filter((option) => option.tier === tier);
}
