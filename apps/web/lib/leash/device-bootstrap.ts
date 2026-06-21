import "server-only";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPendingBootstrap,
  completeBootstrap,
  type DeviceBootstrapFile,
  type DeviceIdentity,
  type DeviceSetupMode,
} from "./device-bootstrap-core.ts";

const here = dirname(fileURLToPath(import.meta.url));
const BASE_DIR = process.env["LEASH_BASE_DIR"] ?? join(here, "..", "..", "..", "..", "data");
const DEVICE_FILE = join(BASE_DIR, "device.json");

function parseBootstrap(input: string): DeviceBootstrapFile | null {
  try {
    const parsed = JSON.parse(input) as Partial<DeviceBootstrapFile>;
    if (parsed.version !== 1) return null;
    if (parsed.mode !== null && parsed.mode !== "first-device" && parsed.mode !== "sync-existing") return null;
    if (typeof parsed.ready !== "boolean") return null;
    if (parsed.identity !== null && parsed.identity !== undefined) {
      if (
        typeof parsed.identity?.userId !== "string" ||
        typeof parsed.identity?.label !== "string" ||
        (parsed.identity?.source !== "fresh" &&
          parsed.identity?.source !== "imported" &&
          parsed.identity?.source !== "migrated") ||
        typeof parsed.identity?.createdAt !== "number"
      ) {
        return null;
      }
    }
    return {
      version: 1,
      mode: parsed.mode ?? null,
      ready: parsed.ready,
      identity: parsed.identity ?? null,
      completedAt: typeof parsed.completedAt === "number" ? parsed.completedAt : null,
    };
  } catch {
    return null;
  }
}

export function readDeviceBootstrap(): DeviceBootstrapFile | null {
  try {
    return parseBootstrap(readFileSync(DEVICE_FILE, "utf8"));
  } catch {
    return null;
  }
}

export function writeDeviceBootstrap(file: DeviceBootstrapFile): void {
  if (!existsSync(BASE_DIR)) mkdirSync(BASE_DIR, { recursive: true });
  const tmp = join(BASE_DIR, `.device.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  renameSync(tmp, DEVICE_FILE);
}

export function startBootstrap(mode: DeviceSetupMode, identity: DeviceIdentity): DeviceBootstrapFile {
  const next = createPendingBootstrap(mode, identity);
  writeDeviceBootstrap(next);
  return next;
}

export function finishBootstrap(now = Date.now()): DeviceBootstrapFile {
  const current = readDeviceBootstrap();
  if (!current || !current.identity) throw new Error("device bootstrap is not initialized");
  const next = completeBootstrap(current, now);
  writeDeviceBootstrap(next);
  return next;
}

export function clearBootstrap(): void {
  rmSync(DEVICE_FILE, { force: true });
}
