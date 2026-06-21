/**
 * Client-side device scope handshake (NOT server-only). After a bootstrap or reset POST,
 * the supervisor respawns the server scoped to the expected device workspace. We poll the
 * public `/api/leash/device/active` probe — connection errors mean "still switching" —
 * until it reports the expected active user, then navigate.
 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function activateAndGo(switchTo: string | null, dest = "/home"): Promise<void> {
  await sleep(800);
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const response = await fetch("/api/leash/device/active", { cache: "no-store" });
      if (response.ok) {
        const data = (await response.json()) as { activeUserId?: string | null };
        if ((data.activeUserId ?? null) === switchTo) {
          window.location.href = dest;
          return;
        }
      }
    } catch {
      /* server down mid-respawn — keep polling */
    }
    if (Date.now() > deadline) {
      window.location.href = dest;
      return;
    }
    await sleep(700);
  }
}
