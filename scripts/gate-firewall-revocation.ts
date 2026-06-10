/**
 * PHASE 1 GATE — does revoking a consumer actually kill its delegated link?
 *
 * The metered watchdog's "cut off a stalled consumer" only has teeth if firewall revocation truly
 * drops a LIVE link. The wrapper is wired (device-provider.ts stop→start; provider.ts `[]`=deny-all),
 * but `startQVACProvider` is idempotent with no dynamic firewall update — so a cached SDK swarm could
 * keep serving a revoked key. This test answers that empirically over the live HTTP surface.
 *
 * Run it with TWO hypha daemons reachable (provider + consumer shim URLs; localhost or SSH-tunneled):
 *
 *   PROVIDER_URL=http://127.0.0.1:11437 \
 *   CONSUMER_URL=http://127.0.0.1:21437 \
 *   ALIAS=<an alias the provider serves & the consumer routes to> \
 *   npm run gate:firewall-revocation
 *
 * Optional: CONSUMER_DEVICE_KEY (else auto-detected if the provider has exactly one peer),
 *           MESSAGE (the prompt), SETTLE_MS (reconcile wait, default 8000).
 *
 * PASS  = after revoke, the consumer's completion can no longer be served (revocation works → Phase 1 done).
 * FAIL  = the revoked consumer is still served (SDK swarm-teardown fix needed before Phase 2 watchdog).
 */
const PROVIDER_URL = (process.env["PROVIDER_URL"] ?? "").replace(/\/+$/, "");
const CONSUMER_URL = (process.env["CONSUMER_URL"] ?? "").replace(/\/+$/, "");
const ALIAS = process.env["ALIAS"] ?? "";
const MESSAGE = process.env["MESSAGE"] ?? "Reply with exactly three words.";
const SETTLE_MS = Number(process.env["SETTLE_MS"] ?? 8_000);
let CONSUMER_DEVICE_KEY = process.env["CONSUMER_DEVICE_KEY"] ?? "";

if (!PROVIDER_URL || !CONSUMER_URL || !ALIAS) {
  console.error("usage: PROVIDER_URL=… CONSUMER_URL=… ALIAS=… [CONSUMER_DEVICE_KEY=…] npm run gate:firewall-revocation");
  process.exit(1);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<{ status: number; body: unknown }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* keep raw text */ }
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

/** A delegated completion: returns the assistant text on a clean 200, or null on any failure. */
async function complete(): Promise<string | null> {
  try {
    const { status, body } = await fetchJson(
      `${CONSUMER_URL}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: ALIAS, messages: [{ role: "user", content: MESSAGE }], stream: false, sensitivity: "private" }),
      },
      90_000,
    );
    if (status !== 200) {
      const err = (body as { error?: { message?: string; code?: string } })?.error;
      console.log(`   → ${status} ${err?.code ?? ""} ${err?.message ?? JSON.stringify(body).slice(0, 160)}`);
      return null;
    }
    const content = (body as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content ?? "";
    return content;
  } catch (err) {
    console.log(`   → request failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

try {
  console.log(`\nPHASE 1 GATE — firewall revocation\n  provider=${PROVIDER_URL}  consumer=${CONSUMER_URL}  alias=${ALIAS}\n`);

  // 1) PRECONDITION: the consumer can be served by the provider right now.
  console.log("① pre-revoke completion (must succeed)…");
  const before = await complete();
  if (before === null) {
    console.error("\n❌ PRECONDITION FAILED: the consumer cannot delegate to the provider even BEFORE revoke.");
    console.error("   Fix the mesh/serve first (pair the two, ensure the provider serves the alias), then re-run.");
    process.exit(2);
  }
  console.log(`   ✅ served: "${before.slice(0, 80).replace(/\n/g, " ")}"`);

  // 2) Identify the consumer to forget on the provider.
  if (!CONSUMER_DEVICE_KEY) {
    const { body } = await fetchJson(`${PROVIDER_URL}/peers`, { method: "GET" }, 10_000);
    const peers = (body as { peers?: Array<{ deviceId?: string; displayName?: string }> })?.peers ?? [];
    if (peers.length === 1 && peers[0]?.deviceId) {
      CONSUMER_DEVICE_KEY = peers[0].deviceId;
      console.log(`② auto-detected consumer deviceKey from provider /peers: ${CONSUMER_DEVICE_KEY.slice(0, 16)}… (${peers[0].displayName ?? "?"})`);
    } else {
      console.error(`\n❌ Could not auto-detect the consumer: provider has ${peers.length} peers. Set CONSUMER_DEVICE_KEY explicitly.`);
      console.error("   provider /peers deviceIds:", peers.map((p) => p.deviceId?.slice(0, 16)).join(", ") || "(none)");
      process.exit(2);
    }
  }

  // 3) Revoke: forget the consumer on the PROVIDER (drops it from the firewall allow-list).
  console.log(`③ revoking on provider (POST /mesh/forget ${CONSUMER_DEVICE_KEY.slice(0, 16)}…)…`);
  const revoke = await fetchJson(
    `${PROVIDER_URL}/mesh/forget`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceKey: CONSUMER_DEVICE_KEY }) },
    20_000,
  );
  if (revoke.status !== 200) {
    console.error(`\n❌ /mesh/forget failed (${revoke.status}): ${JSON.stringify(revoke.body).slice(0, 200)}`);
    process.exit(2);
  }
  console.log(`   ✅ forget acked; waiting ${SETTLE_MS}ms for the provider's firewall stop→start reconcile…`);
  await sleep(SETTLE_MS);

  // 4) POST-REVOKE: the consumer must NO LONGER be served.
  console.log("④ post-revoke completion (must FAIL if revocation works)…");
  const after = await complete();

  if (after === null) {
    console.log("\n✅ GATE PASS — the revoked consumer can no longer be served.");
    console.log("   Firewall revocation works at the SDK level. Phase 1 is satisfied; the Phase 2 watchdog's");
    console.log("   connection-level cutoff has teeth. (Confirm the provider audit shows a firewall reconcile.)");
    process.exit(0);
  }
  console.log(`\n❌ GATE FAIL — the revoked consumer was STILL served: "${after.slice(0, 80).replace(/\n/g, " ")}"`);
  console.log("   The SDK swarm kept the established link alive despite stop→start. Phase 1 needs a real fix:");
  console.log("   destroy/replace the SDK swarm on revoke (not just stopQVACProvider→startProvider), OR close the");
  console.log("   live consumer connection explicitly. The metered watchdog's money backstop (settle the cap)");
  console.log("   still works, but it cannot CUT the link until this is fixed.");
  process.exit(1);
} catch (error) {
  console.error("\n❌ gate test errored:", error instanceof Error ? error.message : error);
  process.exit(2);
}
