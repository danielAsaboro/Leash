/**
 * macOS acceptance smoke for the warm-cache offline requester path.
 *
 * The child process is denied every non-loopback outbound connection by sandbox-exec. It first
 * proves that an ordinary HTTPS request cannot leave the machine, then submits a real public QVAC
 * completion through the already-warmed local Hypha product route. Hypha and the remote provider
 * intentionally remain outside this process sandbox: this proves the requester/product boundary,
 * not a host-wide network cut. The report carries that scope so it cannot be presented otherwise.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const inside = process.argv.includes("--inside-wan-denied-sandbox");
const baseUrl = (process.env["LEASH_PUBLIC_OFFLINE_URL"] ?? "http://127.0.0.1:12437/v1").replace(/\/+$/, "");
const wholeRequesterUidWanDenied = process.env["LEASH_OFFLINE_UID_WAN_DENIED"] === "1";

async function runInside(): Promise<void> {
  let externalFailure = "";
  try {
    const external = await fetch("https://example.com", { method: "HEAD", signal: AbortSignal.timeout(4_000) });
    externalFailure = `unexpected HTTP ${external.status}`;
  } catch (error) {
    externalFailure = error instanceof Error ? error.message : String(error);
  }
  assert.ok(!externalFailure.startsWith("unexpected HTTP"), `WAN probe escaped the sandbox: ${externalFailure}`);

  const started = performance.now();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "chat",
      messages: [{ role: "user", content: "Reply with exactly: WARM OFFLINE PUBLIC QVAC" }],
      routeMode: "public",
      sensitivity: "shareable",
      stream: false,
      max_tokens: 32,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  assert.equal(response.ok, true, `public request failed: ${response.status} ${JSON.stringify(body)}`);
  const routing = body["leash_routing"] as Record<string, unknown> | undefined;
  assert.equal(routing?.["route"], "public", "WAN-denied request silently used a non-public route");
  assert.match(String(routing?.["jobId"] ?? ""), /^[0-9a-f-]{36}$/i, "missing correlated public job id");
  assert.match(String(routing?.["providerId"] ?? ""), /^[0-9a-f]{64}$/i, "missing public provider identity");

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scope: {
      requesterProductProcessWanDenied: true,
      loopbackToPrewarmedHyphaAllowed: true,
      requesterUidWanDenied: wholeRequesterUidWanDenied,
      hyphaDaemonWanDenied: wholeRequesterUidWanDenied,
      providerDaemonWanDenied: false,
      hostWideWanDisabled: false,
    },
    wanProbe: { blocked: true, error: externalFailure },
    request: {
      status: response.status,
      elapsedMs: Math.round(performance.now() - started),
      route: routing?.["route"],
      jobId: routing?.["jobId"],
      providerId: routing?.["providerId"],
      requesterTtftMs: routing?.["requesterTtftMs"],
      providerTtftMs: routing?.["ttftMs"],
      tokensPerSecond: routing?.["tokensPerSecond"],
      connectionTransport: routing?.["connectionTransport"],
    },
  };
  await mkdir(join(process.cwd(), "logs"), { recursive: true });
  const path = join(process.cwd(), "logs", `public-offline-client-${Date.now().toString(36)}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, reportPath: path }, null, 2));
}

async function runParent(): Promise<void> {
  assert.equal(process.platform, "darwin", "this acceptance smoke requires macOS sandbox-exec");
  if (wholeRequesterUidWanDenied) {
    let escaped = false;
    try { const response = await fetch("https://example.com", { method: "HEAD", signal: AbortSignal.timeout(4_000) }); escaped = response.ok; }
    catch { /* expected: the caller's UID-wide packet filter blocks WAN */ }
    assert.equal(escaped, false, "UID-wide WAN probe escaped before the offline smoke");
  }
  const profile = '(version 1)(allow default)(deny network-outbound (require-not (remote ip "localhost:*")))';
  const script = fileURLToPath(import.meta.url);
  const args = ["-p", profile, process.execPath, "--import", "tsx", script, "--inside-wan-denied-sandbox"];
  const child = spawn("sandbox-exec", args, { cwd: process.cwd(), env: process.env, stdio: "inherit" });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (value) => resolve(value ?? 1));
  });
  assert.equal(code, 0, `WAN-denied public requester smoke exited ${code}`);
}

if (inside) await runInside();
else await runParent();
