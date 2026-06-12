/**
 * netmon — the offline-proof HUD's data source (server-only).
 *
 * Lists the machine's ESTABLISHED TCP sockets via `lsof`, scopes them to the QVAC stack
 * (node/tsx/bun/qvac/next processes + the known stack ports), and classifies each remote:
 *   - loopback  (127.0.0.0/8, ::1)            — same-device
 *   - lan/mesh  (RFC-1918 / link-local / ULA / CGNAT / *.local) — the P2P device mesh
 *   - cloud     (anything else)               — THE count that must be 0 offline
 *
 * Honesty: on any `lsof` failure we return `ok:false` (the HUD shows "monitor unavailable"),
 * NEVER a fabricated `0`. A green badge means we looked and found nothing leaving the device.
 */
import "server-only";
import { execFile } from "node:child_process";

/** Stack listen/serve ports — used to include a stack process even if its command name
 *  isn't one of the runtimes below (e.g. a qvac serve worker). Outbound calls still get
 *  caught by the command-name scope, since they originate from these processes. */
const QVAC_PORTS = new Set([6800, 6801, 11436, 11437, 11449, 8545, 3000, 3001]);
/** Runtimes the QVAC stack runs under. Scope is by PROCESS identity (not port) because an
 *  app phoning home connects from an ephemeral local port to a remote 443 — neither is a
 *  stack port, so only the owning process betrays it. Over-inclusive on purpose (a node app
 *  that isn't ours can only make the badge MORE cautious, never falsely green). */
const STACK_CMD = /^(node|tsx|bun|qvac|next|mycelium)/i;

export interface NetSocket {
  command: string;
  pid: string;
  remote: string;
}
export interface NetMon {
  ok: boolean;
  error?: string;
  sampledAt: string;
  /** Distinct `command(pid)` strings the sample covered (for the badge's "what I watch"). */
  monitored: string[];
  loopback: number;
  lan: NetSocket[];
  cloud: NetSocket[];
}

/** Host portion of an lsof endpoint token (`host:port` or `[ipv6]:port`). */
function hostOf(ep: string): string {
  const v6 = ep.match(/^\[([^\]]+)\]:\d+$/);
  if (v6) return v6[1]!;
  const i = ep.lastIndexOf(":");
  return i >= 0 ? ep.slice(0, i) : ep;
}
function portOf(ep: string): number {
  const i = ep.lastIndexOf(":");
  return i >= 0 ? Number(ep.slice(i + 1)) : NaN;
}

function classify(host: string): "loopback" | "lan" | "cloud" {
  if (host === "::1" || host === "localhost" || /^127\./.test(host)) return "loopback";
  if (/^10\./.test(host)) return "lan";
  if (/^192\.168\./.test(host)) return "lan";
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return "lan";
  if (/^169\.254\./.test(host)) return "lan"; // IPv4 link-local
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return "lan"; // RFC-6598 CGNAT (mesh VPN)
  if (/^fe80:/i.test(host)) return "lan"; // IPv6 link-local
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return "lan"; // IPv6 ULA fc00::/7
  if (host.endsWith(".local")) return "lan"; // mDNS
  return "cloud";
}

/** Run lsof and return its stdout, tolerating a non-zero exit when output is still produced
 *  (lsof exits 1 on benign per-socket warnings). Rejects only when there's nothing to parse. */
function runLsof(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "lsof",
      ["-nP", "-iTCP", "-sTCP:ESTABLISHED"],
      { timeout: 1500, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PATH: `${process.env["PATH"] ?? ""}:/usr/sbin:/sbin:/usr/bin` } },
      (err, stdout) => {
        if (stdout && stdout.trim()) return resolve(stdout);
        if (err) return reject(err);
        resolve(stdout ?? "");
      },
    );
  });
}

export async function sampleNetwork(): Promise<NetMon> {
  const sampledAt = new Date().toISOString();
  let out: string;
  try {
    out = await runLsof();
  } catch (err) {
    return { ok: false, error: `lsof unavailable: ${err instanceof Error ? err.message : String(err)}`, sampledAt, monitored: [], loopback: 0, lan: [], cloud: [] };
  }

  const monitored = new Set<string>();
  let loopback = 0;
  const lan: NetSocket[] = [];
  const cloud: NetSocket[] = [];

  for (const line of out.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9 || parts[0] === "COMMAND") continue;
    const command = parts[0]!;
    const pid = parts[1]!;
    const nameTok = parts.find((p) => p.includes("->"));
    if (!nameTok) continue;
    const [localEp, remoteEp] = nameTok.split("->");
    if (!remoteEp) continue;

    const inStack = STACK_CMD.test(command) || QVAC_PORTS.has(portOf(localEp ?? "")) || QVAC_PORTS.has(portOf(remoteEp));
    if (!inStack) continue;

    monitored.add(`${command}(${pid})`);
    const klass = classify(hostOf(remoteEp));
    if (klass === "loopback") loopback++;
    else if (klass === "lan") lan.push({ command, pid, remote: remoteEp });
    else cloud.push({ command, pid, remote: remoteEp });
  }

  return { ok: true, sampledAt, monitored: [...monitored].slice(0, 16), loopback, lan, cloud };
}
