/**
 * Pairing controller — LAN discovery + the PIN click-to-pair handshake.
 *
 * Active only in "pairing mode" (Add a device): it advertises + browses over mDNS and
 * opens the LAN plane (`HYPHA_PAIR_PORT`, the ONLY non-localhost surface). The dashboard
 * drives it over the localhost control routes (on the shim); other devices reach it over
 * the LAN plane. Mode auto-exits after a timeout.
 *
 * Handshake (initiator A clicks Pair on target B):
 *   A → B `/pair/initiate {name, writerKey}` → B shows a PIN, returns a sessionId
 *   (operator reads B's PIN, types it into A)
 *   A → B `/pair/confirm {sessionId, pin}` → B allow-lists A's key, returns a blind invite
 *   A redeems the invite → joins B's mesh.
 *
 * Security: the PIN proves A's operator can see B's screen; the mesh `allowedDevices`
 * firewall (B allow-lists ONLY A's key) makes a sniffed invite useless to anyone else.
 * A joiner must be UNPAIRED (no existing mesh) — pairing brings a newcomer into a mesh,
 * it does not merge two populated meshes.
 */
import http from "node:http";
import { randomInt, randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import type { AuditLog } from "@mycelium/shared";
import { startDiscovery, type DiscoveredDevice, type DiscoveryHandle } from "./discovery.ts";
import type { PairingControl, PairingState } from "./shim.ts";
import { COMPUTE_CLASS, HYPHA_PAIR_PORT, MESH_STORE_DIR, PAIR_MODE_TIMEOUT_MS, RAM_MB } from "./config.ts";

/** What the controller needs from the daemon's mesh lifecycle (implemented in main.ts). */
export interface MeshController {
  displayName(): string;
  /** True if this device is already in a mesh (so it can host, but must NOT initiate joining). */
  inMesh(): boolean;
  /** Stable writer key: the live mesh key, or a prospective one (creating the store) if unpaired. */
  localKey(): Promise<string>;
  /** Device keys (deviceIds) of already-paired peers, to drop from the discovered list. */
  pairedDeviceKeys(): Promise<Set<string>>;
  /** HOST: ensure a mesh exists (found if none), allow-list the initiator, return a blind invite. */
  hostInvite(initiatorWriterKey: string): Promise<string>;
  /** JOINER: redeem an invite and bring the mesh online (requires !inMesh). */
  joinWith(invite: string): Promise<void>;
}

interface Outgoing {
  targetKey: string;
  targetName: string;
  host: string;
  port: number;
  sessionId: string;
  status: "await-pin" | "pairing" | "done";
  error?: string;
}
interface Incoming {
  initiatorName: string;
  initiatorKey: string;
  pin: string;
  attempts: number;
  sessionId: string;
}

const newPin = (): string => randomInt(0, 1_000_000).toString().padStart(6, "0");

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

export class PairingController implements PairingControl {
  private mode = false;
  private modeTimer: ReturnType<typeof setTimeout> | null = null;
  private modeExpiresAt = 0;
  private discovery: DiscoveryHandle | null = null;
  private lan: http.Server | null = null;
  private selfKey = "";
  private outgoing: Outgoing | null = null;
  private incoming: Incoming | null = null;
  private lastError: string | null = null;
  /** True while a background joinWith is in flight (guards exit()'s store cleanup). */
  private joining = false;

  private readonly pairPort: number;

  constructor(
    private readonly mesh: MeshController,
    private readonly audit?: AuditLog,
    pairPort: number = HYPHA_PAIR_PORT,
  ) {
    this.pairPort = pairPort;
  }

  async setMode(on: boolean): Promise<{ ok: boolean; error?: string }> {
    if (on) {
      if (this.mode) {
        this.armTimeout();
        return { ok: true };
      }
      try {
        this.selfKey = await this.mesh.localKey();
      } catch (err) {
        return { ok: false, error: `cannot enter pairing mode: ${String(err)}` };
      }
      this.discovery = startDiscovery(
        { name: this.mesh.displayName(), port: this.pairPort, deviceKey: this.selfKey, fp: this.selfKey.slice(0, 8), computeClass: COMPUTE_CLASS, ramMB: RAM_MB },
        this.selfKey,
      );
      this.lan = http.createServer((req, res) => void this.handleLan(req, res));
      this.lan.on("error", (e) => { this.lastError = `LAN plane: ${e.message}`; });
      this.lan.listen(this.pairPort, "0.0.0.0");
      this.mode = true;
      this.lastError = null;
      this.armTimeout();
      this.audit?.record({ event: "pairing", extra: { role: "self", phase: "mode-on" } });
      return { ok: true };
    }
    await this.exit();
    return { ok: true };
  }

  private armTimeout(): void {
    if (this.modeTimer) clearTimeout(this.modeTimer);
    this.modeExpiresAt = Date.now() + PAIR_MODE_TIMEOUT_MS;
    this.modeTimer = setTimeout(() => void this.exit(), PAIR_MODE_TIMEOUT_MS);
    if (typeof this.modeTimer.unref === "function") this.modeTimer.unref();
  }

  private async exit(): Promise<void> {
    if (this.modeTimer) clearTimeout(this.modeTimer);
    this.modeTimer = null;
    this.discovery?.stop();
    this.discovery = null;
    if (this.lan) await new Promise<void>((r) => this.lan!.close(() => r()));
    this.lan = null;
    this.outgoing = null;
    this.incoming = null;
    this.mode = false;
    // A prospective store was created for advertising; if we never actually joined/hosted a
    // mesh, it's an empty lone store — remove it so the daemon doesn't found a mesh from it.
    // NEVER while a join is still in flight: deleting the corestore out from under the
    // blind-pairing handshake corrupts/zombifies the daemon.
    if (!this.joining && !this.mesh.inMesh() && existsSync(MESH_STORE_DIR)) {
      try {
        rmSync(MESH_STORE_DIR, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    this.audit?.record({ event: "pairing", extra: { role: "self", phase: "mode-off" } });
  }

  async cancel(): Promise<void> {
    await this.exit();
  }

  // ── LAN plane (called by OTHER devices) ───────────────────────────────────────
  private async handleLan(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (!this.mode) return send(403, { error: "not in pairing mode" });
    const url = req.url ?? "/";
    if (req.method !== "POST") return send(404, { error: "not found" });

    if (url.startsWith("/pair/initiate")) {
      const body = await readJson(req);
      const initiatorName = String(body["initiatorName"] ?? "a device");
      const initiatorKey = String(body["initiatorWriterKey"] ?? "");
      if (!initiatorKey) return send(400, { error: "initiatorWriterKey required" });
      if (this.incoming) return send(409, { error: "already pairing with another device" });
      this.incoming = { initiatorName, initiatorKey, pin: newPin(), attempts: 0, sessionId: randomUUID() };
      this.audit?.record({ event: "pairing", extra: { role: "host", phase: "initiate", from: initiatorName } });
      return send(200, { sessionId: this.incoming.sessionId });
    }

    if (url.startsWith("/pair/confirm")) {
      const body = await readJson(req);
      const sessionId = String(body["sessionId"] ?? "");
      const pin = String(body["pin"] ?? "");
      if (!this.incoming || this.incoming.sessionId !== sessionId) return send(404, { error: "no such pairing session" });
      if (pin !== this.incoming.pin) {
        this.incoming.attempts++;
        if (this.incoming.attempts >= 3) {
          this.incoming = null;
          return send(403, { error: "too many wrong PINs — start over" });
        }
        return send(403, { error: "wrong PIN" });
      }
      try {
        const invite = await this.mesh.hostInvite(this.incoming.initiatorKey);
        this.audit?.record({ event: "pairing", extra: { role: "host", phase: "confirmed", from: this.incoming.initiatorName } });
        this.incoming = null;
        return send(200, { invite });
      } catch (err) {
        this.lastError = `host pairing failed: ${String(err)}`;
        return send(500, { error: this.lastError });
      }
    }
    return send(404, { error: "not found" });
  }

  // ── Control plane (called by THIS device's dashboard, via the shim) ───────────
  discovered(): DiscoveredDevice[] {
    return this.discovery?.list() ?? [];
  }

  async start(targetDeviceKey: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.mode) return { ok: false, error: "open Add a device first" };
    if (this.mesh.inMesh()) return { ok: false, error: "this device is already in a mesh — pair from the other device instead" };
    const target = this.discovered().find((d) => d.deviceKey === targetDeviceKey);
    if (!target) return { ok: false, error: "device is no longer visible" };
    let ourKey: string;
    try {
      ourKey = await this.mesh.localKey();
    } catch (err) {
      return { ok: false, error: String(err) };
    }
    try {
      const r = await fetch(`http://${target.host}:${target.port}/pair/initiate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ initiatorName: this.mesh.displayName(), initiatorWriterKey: ourKey }),
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) return { ok: false, error: `${target.name} refused: ${((await r.json().catch(() => ({}))) as { error?: string }).error ?? r.status}` };
      const { sessionId } = (await r.json()) as { sessionId: string };
      this.outgoing = { targetKey: target.deviceKey, targetName: target.name, host: target.host, port: target.port, sessionId, status: "await-pin" };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `could not reach ${target.name}: ${String(err)}` };
    }
  }

  async submitPin(pin: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.outgoing) return { ok: false, error: "no pairing in progress" };
    const o = this.outgoing;
    o.status = "pairing";
    o.error = undefined;
    try {
      // Generous timeout: a fresh host FOUNDS its mesh inside this confirm (store + swarm +
      // SDK provider — seconds). 10s used to abort mid-founding, and the retry then raced
      // the half-open store into a rocksdb lock error on the host.
      const r = await fetch(`http://${o.host}:${o.port}/pair/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: o.sessionId, pin }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok) {
        o.status = "await-pin";
        o.error = ((await r.json().catch(() => ({}))) as { error?: string }).error ?? `error ${r.status}`;
        return { ok: false, error: o.error };
      }
      const { invite } = (await r.json()) as { invite: string };
      // Join in the BACKGROUND: the blind-pairing handshake can take tens of seconds (and a
      // broken host can fail it). Holding this HTTP response open would time out the
      // dashboard's proxy — which then reads as "daemon not running" while the daemon is
      // fine. The UI polls /pair/state; status flips to done (or back to await-pin with the
      // error) there.
      this.joining = true;
      void this.mesh
        .joinWith(invite)
        .then(() => {
          o.status = "done";
          this.audit?.record({ event: "pairing", extra: { role: "joiner", phase: "joined", target: o.targetName } });
          setTimeout(() => void this.exit(), 1500);
        })
        .catch((err: unknown) => {
          o.status = "await-pin";
          o.error = `joining failed: ${err instanceof Error ? err.message : String(err)}`;
          this.audit?.record({ event: "pairing", extra: { role: "joiner", phase: "join-failed", target: o.targetName, error: String(err) } });
        })
        .finally(() => {
          this.joining = false;
        });
      return { ok: true };
    } catch (err) {
      o.status = "await-pin";
      o.error = String(err);
      return { ok: false, error: o.error };
    }
  }

  async state(): Promise<PairingState> {
    const paired = await this.mesh.pairedDeviceKeys().catch(() => new Set<string>());
    return {
      mode: this.mode,
      expiresInMs: this.mode ? Math.max(0, this.modeExpiresAt - Date.now()) : null,
      meshOnline: this.mesh.inMesh(),
      selfName: this.mesh.displayName(),
      discovered: this.discovered().filter((d) => !paired.has(d.deviceKey)),
      outgoing: this.outgoing ? { targetName: this.outgoing.targetName, status: this.outgoing.status, ...(this.outgoing.error ? { error: this.outgoing.error } : {}) } : null,
      incoming: this.incoming ? { initiatorName: this.incoming.initiatorName, pin: this.incoming.pin } : null,
      error: this.lastError,
    };
  }
}
