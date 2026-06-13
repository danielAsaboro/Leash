/**
 * The marketing "home" — where the logo points. In local dev it's the in-app landing page (`/`);
 * in prod it's the live marketing site. Host-checked client-side; callers should set it post-mount
 * (useEffect) to avoid an SSR/client href mismatch.
 */
/** True when the page is served from a local/LAN host (i.e. the on-device app is reachable). */
export function isLocal(): boolean {
  if (typeof window === "undefined") return false;
  const h = window.location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0" || h.endsWith(".local") || h.startsWith("192.168.") || h.startsWith("10.");
}

export function siteHome(): string {
  return isLocal() ? "/" : "https://useleash.xyz/";
}
