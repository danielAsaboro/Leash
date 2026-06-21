export type MeshModel = { alias: string; modelSrc: string; modelType?: string; borrowable?: boolean; projectionModelSrc?: string };

export type MeshPeer = {
  deviceId: string;
  displayName: string;
  computeClass: string;
  isProvider: boolean;
  joinedAt: number;
  lastSeen: string;
  providerPublicKey?: string;
  consumerPublicKey?: string;
  meshId?: string;
  models?: MeshModel[];
  availableModels?: string[];
  inflight?: number;
};

export type ProviderModality = "chat" | "vision";

export type MeshOffloadTarget = {
  providerPublicKey: string;
  modelSrc: string;
  alias: string;
  displayName: string;
  deviceId: string;
  modelType: ProviderModality;
};

function matchesModality(model: MeshModel, modality: ProviderModality): boolean {
  if (model.borrowable === false || !model.modelSrc) return false;
  if (modality === "chat") return model.alias === "chat" || model.modelType === "chat";
  return model.modelType === "vision" || Boolean(model.projectionModelSrc);
}

export function pickProviderFromPeers(
  peers: MeshPeer[],
  modality: ProviderModality,
  staleMs = 45_000,
  now = Date.now(),
  preferredProviderKey?: string,
): MeshOffloadTarget | null {
  const candidates: Array<{ target: MeshOffloadTarget; inflight: number }> = [];

  for (const peer of peers) {
    if (!peer.isProvider || !peer.providerPublicKey) continue;
    if (now - (Date.parse(peer.lastSeen || "") || 0) > staleMs) continue;

    const model = (peer.models ?? []).find((candidate) => matchesModality(candidate, modality));
    if (!model) continue;

    candidates.push({
      inflight: peer.inflight ?? 0,
      target: {
        providerPublicKey: peer.providerPublicKey,
        modelSrc: model.modelSrc,
        alias: model.alias,
        displayName: peer.displayName,
        deviceId: peer.deviceId,
        modelType: modality,
      },
    });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) =>
    a.inflight - b.inflight
    || a.target.providerPublicKey.localeCompare(b.target.providerPublicKey)
    || a.target.alias.localeCompare(b.target.alias),
  );
  const best = candidates[0]!;
  // Discovery/Autobase row order is not stable. Keep the current live provider when it is tied
  // on load; switch only when another provider is genuinely less loaded. This prevents the phone's
  // target and UI receipt from flapping every roster poll while preserving load shedding.
  const preferred = preferredProviderKey
    ? candidates.find((candidate) => candidate.target.providerPublicKey === preferredProviderKey)
    : undefined;
  return (preferred && preferred.inflight === best.inflight ? preferred : best).target;
}
