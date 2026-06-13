/**
 * Client-side login/switch handshake (NOT server-only). After a login/setup/logout/reset POST,
 * the supervisor respawns the server scoped to the new user (or bootstrap). We poll the public
 * `/api/leash/auth/active` probe — connection errors mean "still switching" — until it reports
 * the expected active user, then navigate.
 */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function activateAndGo(switchTo: string | null, dest = "/home"): Promise<void> {
  await sleep(800); // let the old process begin exiting before the first probe
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const r = await fetch("/api/leash/auth/active", { cache: "no-store" });
      if (r.ok) {
        const j = (await r.json()) as { activeUserId?: string | null };
        if ((j.activeUserId ?? null) === switchTo) {
          window.location.href = dest;
          return;
        }
      }
    } catch {
      /* server down mid-respawn — keep polling */
    }
    if (Date.now() > deadline) {
      window.location.href = dest; // give up waiting; let middleware route us
      return;
    }
    await sleep(700);
  }
}
