import * as FileSystem from "expo-file-system/legacy";

export type DeviceSetupMode = "first-device" | "sync-existing";

export type OnboardingState = {
  version: 1;
  completedAt: number;
  mode: DeviceSetupMode;
};

const FILE = `${FileSystem.documentDirectory}onboarding.json`;
const MESH_META = `${FileSystem.documentDirectory}mesh-store/mesh-meta.json`;
const CHAT_DIR = `${FileSystem.documentDirectory}chats`;

async function hasChatHistory(): Promise<boolean> {
  try {
    const info = await FileSystem.getInfoAsync(CHAT_DIR);
    if (!info.exists || !info.isDirectory) return false;
    const files = await FileSystem.readDirectoryAsync(CHAT_DIR);
    return files.some((file) => file.endsWith(".json"));
  } catch {
    return false;
  }
}

async function inferExistingInstall(): Promise<OnboardingState | null> {
  try {
    const meshInfo = await FileSystem.getInfoAsync(MESH_META);
    if (meshInfo.exists) {
      const meta = JSON.parse(await FileSystem.readAsStringAsync(MESH_META)) as { joined?: boolean };
      return {
        version: 1,
        completedAt: Date.now(),
        mode: meta.joined ? "sync-existing" : "first-device",
      };
    }
  } catch {
    /* ignore */
  }

  if (await hasChatHistory()) {
    return {
      version: 1,
      completedAt: Date.now(),
      mode: "first-device",
    };
  }

  return null;
}

export async function getOnboardingState(): Promise<OnboardingState | null> {
  try {
    const info = await FileSystem.getInfoAsync(FILE);
    if (info.exists) {
      const data = JSON.parse(await FileSystem.readAsStringAsync(FILE)) as Partial<OnboardingState>;
      if (data.version === 1 && (data.mode === "first-device" || data.mode === "sync-existing")) {
        return {
          version: 1,
          completedAt: typeof data.completedAt === "number" ? data.completedAt : Date.now(),
          mode: data.mode,
        };
      }
    }
  } catch {
    /* ignore */
  }

  return inferExistingInstall();
}

export async function saveOnboardingState(mode: DeviceSetupMode): Promise<void> {
  try {
    const next: OnboardingState = { version: 1, completedAt: Date.now(), mode };
    await FileSystem.writeAsStringAsync(FILE, JSON.stringify(next));
  } catch {
    /* best-effort */
  }
}

export async function clearOnboardingState(): Promise<void> {
  try {
    await FileSystem.deleteAsync(FILE, { idempotent: true });
  } catch {
    /* best-effort */
  }
}
