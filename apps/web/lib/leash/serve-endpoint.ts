/**
 * The direct QVAC serve endpoint is deliberately separate from QVAC_OPENAI_URL.
 * Chat normally points QVAC_OPENAI_URL at the priority broker (:11436), while the
 * Services controller and model inventory must probe/control the real serve (:11435).
 */
export function qvacServeOpenAiUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = env["QVAC_SERVE_URL"] ?? env["LEASH_BROKER_UPSTREAM"] ?? "http://127.0.0.1:11435";
  const url = new URL(raw);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/v1") ? path : `${path}/v1`;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export const QVAC_SERVE_OPENAI_URL = qvacServeOpenAiUrl();
