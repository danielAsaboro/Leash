import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createPublicDirectoryServer } from "./public-directory.ts";

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const server = createPublicDirectoryServer({
    discover: async () => ({ providers: [{ advert: { providerId: "a".repeat(64) } }], invalid: [], discoveryMs: 3 }),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { server.close(); await once(server, "close"); }
}

test("LAN directory exposes only public signed-advert discovery", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/public/compute`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual(await response.json(), {
      ok: true, providers: [{ advert: { providerId: "a".repeat(64) } }], invalid: [], discoveryMs: 3,
    });

    assert.equal((await fetch(`${base}/mesh/members`)).status, 404);
    assert.equal((await fetch(`${base}/public/compute/settings`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${base}/public/compute/jobs/private-job`)).status, 404);
  });
});

test("LAN directory fails closed when discovery is unavailable", async () => {
  const server = createPublicDirectoryServer({ discover: async () => { throw new Error("offline"); } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/public/compute`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, error: "public compute unavailable" });
  } finally { server.close(); await once(server, "close"); }
});
