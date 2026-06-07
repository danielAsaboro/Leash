/**
 * `fetch` with a timeout (isomorphic — client components and server code) so a hung
 * request surfaces as an honest error instead of spinning forever.
 *
 * DELIBERATELY NOT USED on:
 *   · the chat generation request / `streamText` upstream — the qvac serve WEDGES its
 *     decode loop machine-wide if a client disconnects mid-generation (chat/route.ts);
 *   · voice `/speak` + `/transcribe` — they manage their own lifecycle AbortControllers;
 *   · server-side `lib/leash` fetches that already carry their own timeouts.
 */

/** Timeout tiers: `probe` = liveness checks, `crud` = dashboard mutations, `heavy` = downloads/imports/start-stop. */
export const TIMEOUT = { probe: 4_000, crud: 10_000, heavy: 30_000 } as const;

export function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, ms: number = TIMEOUT.crud): Promise<Response> {
  const timeout = AbortSignal.timeout(ms);
  return fetch(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
}
