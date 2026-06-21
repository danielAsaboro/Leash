export type DeviceSetupMode = "first-device" | "sync-existing";
export type DeviceIdentitySource = "fresh" | "imported" | "migrated";

export interface DeviceIdentity {
  userId: string;
  label: string;
  source: DeviceIdentitySource;
  createdAt: number;
}

export interface DeviceBootstrapFile {
  version: 1;
  mode: DeviceSetupMode | null;
  ready: boolean;
  identity: DeviceIdentity | null;
  completedAt: number | null;
}

const PUBLIC_EXACT = new Set(["/", "/welcome"]);
const PUBLIC_PREFIX = [
  "/api/leash/bootstrap/",
  "/api/leash/device/active",
  "/api/leash/models/download",
  "/api/leash/downloads",
  "/api/waitlist",
  "/landing/",
  "/_next/",
  "/favicon",
  "/icon-",
  "/apple-touch",
];

export function createDeviceIdentity(source: DeviceIdentitySource, now = Date.now()): DeviceIdentity {
  return {
    userId: `device-${now.toString(36)}`,
    label: "This device",
    source,
    createdAt: now,
  };
}

export function createPendingBootstrap(mode: DeviceSetupMode, identity: DeviceIdentity): DeviceBootstrapFile {
  return {
    version: 1,
    mode,
    ready: false,
    identity,
    completedAt: null,
  };
}

export function completeBootstrap(file: DeviceBootstrapFile, now = Date.now()): DeviceBootstrapFile {
  return {
    ...file,
    ready: true,
    completedAt: now,
  };
}

export function bootstrapNeedsWelcome(file: DeviceBootstrapFile | null): boolean {
  return !file || !file.ready || !file.identity;
}

export function routeNeedsWelcome(pathname: string, ready: boolean): boolean {
  if (PUBLIC_EXACT.has(pathname)) return false;
  if (PUBLIC_PREFIX.some((prefix) => pathname === prefix || pathname.startsWith(prefix))) return false;
  return !ready;
}
