/**
 * Router tool-group — capability discovery + deterministic ranking for the Conductor.
 * Sources live mesh data from hypha's GET /peers (the warm-pool view). Mesh visibility metadata
 * maps peer routes to private/public tiers; missing visibility fails closed to private.
 *
 * REAL /peers shape (confirmed from apps/hypha/src/warm-pool.ts + mesh-router.ts):
 *   Response:  { peers: PeerView[], self: { providerKey, wallet }, leader, ...meshInfo }
 *   PeerView:  { deviceId, displayName, peerId?, computeClass, ramMB, powerState,
 *               inflight, models: string[], modelInfo?, warmModels, live, warm,
 *               lastSeen, pricePerKiloToken?, reputationScore?, effectiveCost?,
 *               shareModels?, settlement?, settlements? }
 *   + added by mesh-router.peers():  meshId, meshLabel, visibility, tier
 *
 * Deviations from the brief's assumed PeerRow:
 *   - NO isLocal flag — the local device is represented in the top-level `self` key, not
 *     in the peers array (warm-pool.peers() explicitly filters selfKey out). The `self`
 *     object only carries { providerKey, wallet }, no model list. We therefore call
 *     GET /health for the local device's warmAliases for get_device_capability.
 *   - models is string[] (alias strings only), NOT { alias, modelSrc }[]. modelSrc is
 *     internal to the warm pool and is NOT serialised into /peers. We set modelSrc to
 *     undefined and omit it from RouteOption (the field is optional in types.ts).
 *   - peerKey in brief → actual field is `peerId` (16-char prefix) OR we assemble from
 *     deviceId. We use `peerId` when present, fall back to `deviceId.slice(0,16)`.
 *   - price.perKiloToken in brief → actual top-level `pricePerKiloToken?: number`.
 */
import { z } from "zod";
import { tagsForAlias } from "../routing/tags.ts";
import { rankRoutes } from "../routing/rank.ts";
import type { RouteOption, Sensitivity, CapabilityBar, Modality, ParamClass, Specialist } from "../routing/types.ts";
import { defineTool, type ToolGroup } from "./types.ts";

const HYPHA_URL = process.env["LEASH_BROKER_HYPHA_URL"] ?? "http://127.0.0.1:11437";
const NO_SOURCES: never[] = [];

/**
 * One row of hypha's /peers response. Field names match the real PeerView type in
 * apps/hypha/src/warm-pool.ts, with meshId/meshLabel appended by mesh-router.peers().
 */
interface PeerRow {
  /** Full device UUID (from DeviceCapability). */
  deviceId: string;
  displayName: string;
  /** 16-char truncated provider public key — the wire peer identifier. May be absent on a
   *  pre-SP2 peer that hasn't re-advertised. */
  peerId?: string;
  /** Full provider public key — populated by the fix-pass PeerView.providerKey field.
   *  This is the key the mesh-router matches on (exact equality); prefer over peerId/deviceId. */
  providerKey?: string;
  computeClass: string;
  ramMB: number;
  powerState: string;
  inflight: number;
  /** Alias strings this peer serves. */
  models: string[];
  /** Per-model modality + borrowable info — present on SP2+ peers. */
  modelInfo?: { alias: string; modelType: string; borrowable: boolean }[];
  warmModels: string[];
  live: boolean;
  warm: boolean;
  lastSeen: string;
  /** µ per kilo-token — present only when a paid x402 rail is configured. */
  pricePerKiloToken?: number;
  shareModels?: boolean;
  /** Added by MeshRouter.peers() — the autobase mesh id this peer belongs to. */
  meshId: string;
  meshLabel: string;
  visibility?: "private" | "public";
  tier?: number;
}

/**
 * Top-level shape of GET /peers. The `self` key describes THIS device (providerKey only,
 * no model list). Peer rows never include the local device.
 */
interface PeersResponse {
  peers: PeerRow[];
  self?: { providerKey: string; wallet: string | null };
  leader?: string | null;
}

/**
 * Top-level shape of GET /health — used by get_device_capability to learn the local
 * device's warmAliases (the local list is not in /peers).
 */
interface HealthResponse {
  ok: boolean;
  port?: number;
  inflight?: number;
  warmAliases?: string[];
}

async function fetchPeers(): Promise<PeersResponse | null> {
  try {
    const res = await fetch(`${HYPHA_URL}/peers`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return (await res.json()) as PeersResponse;
  } catch {
    return null; // offline / hypha down → caller treats as "no peers"
  }
}

async function fetchHealth(): Promise<HealthResponse | null> {
  try {
    const res = await fetch(`${HYPHA_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return (await res.json()) as HealthResponse;
  } catch {
    return null;
  }
}

/** Expand a peer row's served aliases into RouteOptions (one per alias).
 *
 * `peerKey` is the FULL providerPublicKey (from `row.providerKey`), which is what
 * mesh-router's `capabilityForProviderKey` and `forwardTargetsForAlias` match against
 * (exact-equality `.find(c => c.providerPublicKey === peerKey)`). We fall back to the
 * 16-char `peerId` prefix or a deviceId slice only for pre-fix hypha builds that don't
 * yet emit `providerKey` — in those cases pinning will silently fail to match, but at
 * least the RouteOption is still usable for display/ranking. */
function rowToOptions(row: PeerRow): RouteOption[] {
  const peerKey = row.providerKey ?? row.peerId ?? row.deviceId.slice(0, 16);
  const tier = row.visibility === "public" ? "public" : "private";
  const pricePerKiloToken = tier === "private" ? 0 : (row.pricePerKiloToken ?? 0);
  return row.models.map((alias) => ({
    tier,
    alias,
    tags: tagsForAlias(alias),
    peerKey,
    meshId: row.meshId,
    // modelSrc is not serialised in /peers; omit (optional field in RouteOption)
    pricePerKiloToken,
    inflight: row.inflight,
  }));
}

/** Build RouteOptions for the local device from its warm aliases (from /health). */
function localAliasesToOptions(warmAliases: string[], inflight: number): RouteOption[] {
  return warmAliases.map((alias) => ({
    tier: "device" as const,
    alias,
    tags: tagsForAlias(alias),
    pricePerKiloToken: 0,
    inflight,
  }));
}

export const routerGroup: ToolGroup = {
  id: "router",
  label: "Router",
  description: "Discover what this device and private-mesh peers can do, and rank routes for a request.",
  tools: [
    defineTool({
      name: "get_device_capability",
      description:
        "Capabilities of THIS device: in-flight load count and the model aliases it currently serves (warm aliases from hypha GET /health). Does NOT report RAM — /health carries no RAM field. Call before deciding whether the local device can handle a turn.",
      inputSchema: {},
      handler: async () => {
        const health = await fetchHealth();
        if (!health?.ok) {
          return {
            text: "Local device capability unavailable (hypha not reachable). Treat as: serves the default chat model only.",
            sources: NO_SOURCES,
          };
        }
        const warmAliases = health.warmAliases ?? [];
        const inflight = health.inflight ?? 0;
        const opts = localAliasesToOptions(warmAliases, inflight);
        const lines = opts.map(
          (o) => `${o.alias} [${o.tags.modality}/${o.tags.paramClass}/${o.tags.specialist}] inflight ${o.inflight}`,
        );
        return {
          text: `This device · inflight ${inflight}\nLocal models:\n${lines.join("\n") || "(none — model serve not running)"}`,
          sources: NO_SOURCES,
        };
      },
    }),

    defineTool({
      name: "list_private_mesh_models",
      description:
        "Models served by peers on the private mesh, with their capability tags, price (µ/kilo-token), and live in-flight load. Use to find a more capable or less-loaded peer to delegate to.",
      inputSchema: {},
      handler: async () => {
        const data = await fetchPeers();
        if (!data) return { text: "No mesh peers reachable (hypha offline). All routing stays local.", sources: NO_SOURCES };
        const peers = data.peers ?? [];
        if (peers.length === 0) return { text: "No mesh peers reachable. All routing stays local.", sources: NO_SOURCES };
        const opts = peers.flatMap((p) => rowToOptions(p));
        if (opts.length === 0) return { text: "Mesh peers visible but none serves any models.", sources: NO_SOURCES };
        const lines = opts.map(
          (o) =>
            `${o.alias} [${o.tags.modality}/${o.tags.paramClass}/${o.tags.specialist}] @${o.peerKey?.slice(0, 8)} · ${o.pricePerKiloToken}µ/ktok · inflight ${o.inflight}`,
        );
        return { text: `Mesh models (${opts.length}):\n${lines.join("\n")}`, sources: NO_SOURCES };
      },
    }),

    defineTool({
      name: "rank_routes",
      description:
        "Given a capability bar (modality, minimum size, optional specialist) and sensitivity, return the ranked routes (best first) across this device, private mesh peers, and public mesh peers. Sensitive turns are hard-gated away from the public tier before cost is considered.",
      inputSchema: {
        modality: z.enum(["text", "vision", "audio"]).describe("Required modality for the turn."),
        minParamClass: z.enum(["tiny", "small", "mid", "large"]).describe("Smallest model size that can do the turn well."),
        specialist: z
          .enum(["general", "health", "vision", "computer"])
          .optional()
          .describe("Required specialist, if any."),
        sensitivity: z.enum(["private", "shareable"]).describe("'private' keeps the turn off the public tier."),
      },
      handler: async ({ modality, minParamClass, specialist, sensitivity }) => {
        // Gather local + remote options in parallel.
        const [health, peersData] = await Promise.all([fetchHealth(), fetchPeers()]);

        const localInflight = health?.inflight ?? 0;
        const localOpts = localAliasesToOptions(health?.warmAliases ?? [], localInflight);
        const remoteOpts = (peersData?.peers ?? []).flatMap((p) => rowToOptions(p));
        const options: RouteOption[] = [...localOpts, ...remoteOpts];

        const bar: CapabilityBar = {
          modality: modality as Modality,
          minParamClass: minParamClass as Exclude<ParamClass, "unknown">,
          ...(specialist ? { specialist: specialist as Specialist } : {}),
        };
        const ranked = rankRoutes({ bar, sensitivity: sensitivity as Sensitivity, options });

        if (ranked.length === 0) {
          return {
            text: "ROUTE: none (no device, private mesh, or allowed public mesh route cleared the bar)",
            sources: NO_SOURCES,
            route: null,
          };
        }
        const top = ranked[0]!;
        const text = `ROUTE: ${top.peerKey ? `peer ${top.alias}` : `local ${top.alias}`} (${top.reason})\nAlternatives: ${ranked.slice(1, 4).map((r) => r.reason).join(" | ") || "none"}`;
        // `route` rides structuredContent → the chat route lifts it to drive execution.
        return {
          text,
          sources: NO_SOURCES,
          route: {
            tier: top.tier,
            alias: top.alias,
            peerKey: top.peerKey ?? null,
            meshId: top.meshId ?? null,
            modelSrc: top.modelSrc ?? null,
          },
          alternatives: ranked.slice(1, 4),
        };
      },
    }),
  ],
};
