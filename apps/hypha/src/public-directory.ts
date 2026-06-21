import http from "node:http";

export interface PublicDirectorySource {
  discover(): Promise<{
    providers: unknown[];
    invalid: Array<{ author: string; reason: string; detail: string }>;
    discoveryMs: number;
  }>;
}

const HEADERS = {
  "access-control-allow-origin": "*",
  "cache-control": "no-store",
  "content-type": "application/json",
  "x-content-type-options": "nosniff",
} as const;

/**
 * The sole LAN-readable Hypha surface outside time-bounded pairing. It deliberately has no
 * mutation, mesh membership, conversation, audit, settings, or job-evidence routes.
 */
export function createPublicDirectoryServer(source: PublicDirectorySource): http.Server {
  return http.createServer(async (req, res) => {
    const url = req.url?.split("?", 1)[0] ?? "/";
    if (req.method === "OPTIONS" && url === "/public/compute") {
      res.writeHead(204, { ...HEADERS, "access-control-allow-methods": "GET, OPTIONS" });
      return res.end();
    }
    if (req.method !== "GET" || url !== "/public/compute") {
      res.writeHead(req.method === "GET" ? 404 : 405, HEADERS);
      return res.end(JSON.stringify({ ok: false, error: req.method === "GET" ? "not found" : "method not allowed" }));
    }
    try {
      const found = await source.discover();
      res.writeHead(200, HEADERS);
      return res.end(JSON.stringify({ ok: true, ...found }));
    } catch {
      res.writeHead(503, HEADERS);
      return res.end(JSON.stringify({ ok: false, error: "public compute unavailable" }));
    }
  }).setTimeout(10_000);
}
