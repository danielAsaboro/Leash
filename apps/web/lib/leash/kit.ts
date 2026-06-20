import { modelAssetsForProfile, modelProfileForDevice, type BrainModelAsset, type BrainModelRole, type BrainModelRoleName } from "@mycelium/brain";

/**
 * Web's model kit is the shared desktop Brain profile. Keep this module as the web-local import
 * seam, but do not define model fleets here.
 */
export type KitRoleName = BrainModelRoleName;
export type KitRole = BrainModelRole;
export type KitModelAsset = BrainModelAsset;

export const ASSISTANT_KIT: KitRole[] = modelProfileForDevice("desktop").roles;

/** Every asset the kit needs downloaded (SDK constants plus explicit QVAC GGUF sources). */
export function kitModelAssets(): KitModelAsset[] {
  return modelAssetsForProfile("desktop");
}

export function kitModels(kit: KitRole[] = ASSISTANT_KIT): string[] {
  return kit.flatMap((r) => {
    const models = r.model ? [r.model] : [];
    const withProjection = r.projection ? [...models, r.projection] : models;
    return r.src && r.downloadName ? [...withProjection, r.downloadName] : withProjection;
  });
}

/** Map an SDK catalog constant to the kit role it fills, if any. */
export function kitRoleOf(modelName: string, kit: KitRole[] = ASSISTANT_KIT): KitRoleName | undefined {
  return kit.find((r) => r.model === modelName || r.projection === modelName || r.downloadName === modelName)?.role;
}
