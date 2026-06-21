import * as FileSystem from "expo-file-system/legacy";
import { getModelInfo } from "@qvac/sdk";
import { leaveMesh } from "./meshClient";
import { clearSecrets } from "./secrets";
import { buildFactoryResetPlan } from "./onboardingPlan";
import { CHAT_MODELS, MODELS } from "./modelsInventory";

async function clearCachedModelFiles(): Promise<void> {
  const names = new Set([
    ...MODELS.map((entry) => entry.name),
    ...CHAT_MODELS.map((entry) => entry.name),
  ]);

  await Promise.all(
    [...names].map(async (name) => {
      try {
        const info = await getModelInfo({ name } as any);
        await Promise.all(
          (info?.cacheFiles ?? []).map((file: { path?: string; isCached?: boolean }) => {
            if (!file?.path || !file.isCached) return Promise.resolve();
            return FileSystem.deleteAsync(file.path, { idempotent: true }).catch(() => {});
          }),
        );
      } catch {
        /* best-effort */
      }
    }),
  );
}

export async function resetDeviceState(): Promise<void> {
  const root = FileSystem.documentDirectory ?? "";
  const plan = buildFactoryResetPlan();

  await leaveMesh().catch(() => {});

  await Promise.all(
    plan.files.map(async (target) => {
      const path = `${root}${target.suffix}`;
      await FileSystem.deleteAsync(path, { idempotent: true }).catch(() => {});
    }),
  );

  await clearCachedModelFiles();
  await clearSecrets(plan.secureStoreKeys).catch(() => {});
}
