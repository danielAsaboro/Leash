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
): MeshOffloadTarget | null {
  let best: MeshOffloadTarget | null = null;
  let bestInflight = Infinity;

  for (const peer of peers) {
    if (!peer.isProvider || !peer.providerPublicKey) continue;
    if (now - (Date.parse(peer.lastSeen || "") || 0) > staleMs) continue;

    const model = (peer.models ?? []).find((candidate) => matchesModality(candidate, modality));
    if (!model) continue;

    const inflight = peer.inflight ?? 0;
    if (inflight < bestInflight) {
      bestInflight = inflight;
      best = {
        providerPublicKey: peer.providerPublicKey,
        modelSrc: model.modelSrc,
        alias: model.alias,
        displayName: peer.displayName,
        deviceId: peer.deviceId,
        modelType: modality,
      };
    }
  }

  return best;
}
