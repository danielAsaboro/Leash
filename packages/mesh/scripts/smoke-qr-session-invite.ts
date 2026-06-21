/**
 * Smoke: QR invite sessions are single-current-session. A stale sid paired with the
 * latest invite must be rejected quickly; the latest sid must still admit a candidate.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AuditLog } from "@mycelium/shared";
import { MeshGraph } from "../src/index.ts";

const root = mkdtempSync(join(tmpdir(), "mesh-qr-session-" + randomUUID().slice(0, 8) + "-"));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(label: string, fn: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await fn()) return;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}`);
}

try {
  const audit = new AuditLog("qr-session-invite-smoke", join(root, "logs"));
  const host = await MeshGraph.open({ storeDir: join(root, "host"), audit });
  await host.joinSwarm();

  const staleSid = randomUUID();
  const latestSid = randomUUID();
  await host.mintInvite({ sessionId: staleSid, meshId: "primary" });
  const latestInvite = await host.mintInvite({ sessionId: latestSid, meshId: "primary" });

  const staleStarted = Date.now();
  await assert.rejects(
    () => MeshGraph.pair({ storeDir: join(root, "stale"), invite: latestInvite, inviteSessionId: staleSid, timeoutMs: 8_000, audit }),
    /stale invite session|pairing rejected|PAIRING_REJECTED/i,
  );
  assert.ok(Date.now() - staleStarted < 5_000, "stale sid should fail fast");

  const joined = await MeshGraph.pair({ storeDir: join(root, "latest"), invite: latestInvite, inviteSessionId: latestSid, timeoutMs: 8_000, audit });
  await waitFor("latest joiner writer promotion", async () => {
    await host.update();
    await joined.update();
    return joined.writable;
  });

  const phases = readFileSync(audit.path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { extra?: unknown })
    .map((record) => record.extra)
    .filter((extra): extra is { phase: string; sid?: string; durationMs?: number } => Boolean(extra && typeof extra === "object" && "phase" in extra));
  assert.ok(phases.some((extra) => extra.phase === "invite-minted" && extra.sid === latestSid));
  assert.ok(phases.some((extra) => extra.phase === "candidate-opened" && extra.sid === latestSid));
  assert.ok(phases.some((extra) => extra.phase === "confirm-sent" && extra.sid === latestSid && (extra.durationMs ?? Infinity) < 15_000));
  assert.ok(phases.some((extra) => extra.phase === "add-writer-done" && extra.sid === latestSid));

  await joined.close();
  await host.close();
  console.log("smoke-qr-session-invite.ts: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
