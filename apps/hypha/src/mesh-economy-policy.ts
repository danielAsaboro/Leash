import type { SettlementEndpoint, Visibility } from "@mycelium/shared";

export const MAX_PRIVATE_MESHES = 1;
export const MAX_PUBLIC_MESHES = 15;

export interface MeshMembershipLike {
  meshId: string;
  visibility: Visibility;
}

export function membershipLimitError(
  records: readonly MeshMembershipLike[],
  visibility: Visibility,
  currentMeshId?: string,
): string | null {
  const count = records.filter((r) => r.visibility === visibility && r.meshId !== currentMeshId).length;
  if (visibility === "private" && count >= MAX_PRIVATE_MESHES) {
    return "A user can belong to only one private mesh.";
  }
  if (visibility === "public" && count >= MAX_PUBLIC_MESHES) {
    return `A user can belong to at most ${MAX_PUBLIC_MESHES} public meshes.`;
  }
  return null;
}

export function advertisedPriceForMesh(visibility: Visibility, pricePerKiloToken: number | null | undefined): number {
  if (visibility === "private") return 0;
  return Math.max(0, Math.floor(Number.isFinite(pricePerKiloToken) ? Number(pricePerKiloToken) : 0));
}

export function paidRailsForMesh(visibility: Visibility, rails: readonly SettlementEndpoint[]): SettlementEndpoint[] {
  if (visibility === "private") return [];
  return rails.filter((rail) => (rail.x402?.pricePerKiloToken ?? 0) > 0);
}

export function requiresPaidSessionForMesh(
  visibility: Visibility,
  pricePerKiloToken: number | null | undefined,
  hasPaidRail: boolean,
): boolean {
  return visibility === "public" && advertisedPriceForMesh(visibility, pricePerKiloToken) > 0 && hasPaidRail;
}

export function paidSessionValidationError(visibility: Visibility): string | null {
  return visibility === "private" ? "private mesh compute is free and cannot open a paid session" : null;
}
