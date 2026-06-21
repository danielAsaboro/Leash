export type DeviceIdentitySource = "fresh" | "imported";

export interface DeviceIdentityRecord {
  version: 1;
  id: string;
  label: string;
  source: DeviceIdentitySource;
  createdAt: number;
}

async function getIdentityFilePath(): Promise<string> {
  const FileSystem = await import("expo-file-system/legacy");
  return `${FileSystem.documentDirectory}device-identity.json`;
}

export function makeDeviceIdentity(source: DeviceIdentitySource, now = Date.now()): DeviceIdentityRecord {
  return {
    version: 1,
    id: `device-${now.toString(36)}`,
    label: "This device",
    source,
    createdAt: now,
  };
}

export async function saveDeviceIdentity(record: DeviceIdentityRecord): Promise<void> {
  const FileSystem = await import("expo-file-system/legacy");
  const file = await getIdentityFilePath();
  await FileSystem.writeAsStringAsync(file, JSON.stringify(record));
}

export async function getDeviceIdentity(): Promise<DeviceIdentityRecord | null> {
  try {
    const FileSystem = await import("expo-file-system/legacy");
    const file = await getIdentityFilePath();
    const info = await FileSystem.getInfoAsync(file);
    if (!info.exists) return null;
    const parsed = JSON.parse(await FileSystem.readAsStringAsync(file)) as Partial<DeviceIdentityRecord>;
    if (parsed.version !== 1 || typeof parsed.id !== "string" || typeof parsed.label !== "string") return null;
    if (parsed.source !== "fresh" && parsed.source !== "imported") return null;
    return {
      version: 1,
      id: parsed.id,
      label: parsed.label,
      source: parsed.source,
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now(),
    };
  } catch {
    return null;
  }
}

export async function clearDeviceIdentity(): Promise<void> {
  const FileSystem = await import("expo-file-system/legacy");
  const file = await getIdentityFilePath();
  await FileSystem.deleteAsync(file, { idempotent: true });
}
