/**
 * LAN discovery (mDNS / Bonjour) — only active while in pairing mode.
 *
 * Advertises this device as a `_hypha._tcp` service (name + LAN pairing port + a TXT record
 * carrying the device key / fingerprint / class / RAM) and browses for others. The browse
 * map is deduped by device key and excludes self; the pairing controller additionally drops
 * already-paired devices. Stopping tears down advertise + browse (mDNS "goodbye").
 */
import Bonjour from "bonjour-service";

/** The subset of a browsed mDNS service record we read (structurally compatible with the lib's Service). */
interface BrowsedService {
  name?: string;
  port: number;
  host?: string;
  txt?: Record<string, unknown>;
  addresses?: string[];
  referer?: { address?: string };
}

const SERVICE_TYPE = "hypha"; // bonjour adds the leading `_` and `_tcp`
const CELL_SERVICE_TYPE = "hyphacell"; // public-cell feed-key announcement (separate from pairing)

export interface DiscoveredDevice {
  deviceKey: string;
  name: string;
  computeClass: string;
  ramMB: number;
  host: string;
  port: number;
  fp: string;
}

export interface DiscoveryAdvertise {
  /** Human name shown in the other device's list. */
  name: string;
  /** This device's LAN pairing port (HYPHA_PAIR_PORT). */
  port: number;
  /** Stable device key (mesh writer key) — used for self-filtering + allow-listing. */
  deviceKey: string;
  fp: string;
  computeClass: string;
  ramMB: number;
}

export interface DiscoveryHandle {
  /** Currently-visible peers (deduped by key, self excluded). */
  list(): DiscoveredDevice[];
  stop(): void;
}

function firstIpv4(s: BrowsedService): string {
  const v4 = (s.addresses ?? []).find((a: string) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  return v4 ?? s.referer?.address ?? s.host ?? "";
}

export interface CellDiscoveryHandle {
  stop(): void;
}

/**
 * Public-cell feed discovery over mDNS (spec §9 / direction B): advertise THIS device's gossip
 * feed key for `cellId`, and call `onPeerFeed(feedKey)` for every OTHER device announcing the same
 * cell on the LAN. That's the whole "no pairing" join — once a peer feed is known, the cell's
 * Hyperswarm replicates it. `port` is unused for transport (the swarm carries data) but mDNS
 * requires one. Not geofenced yet — `cellId` is an agreed string; Phase 3 makes it a geohash.
 */
export function startCellDiscovery(cellId: string, feedKey: string, port: number, onPeerFeed: (feedKey: string) => void): CellDiscoveryHandle {
  const bonjour = new Bonjour();
  const service = bonjour.publish({
    name: `cell-${feedKey.slice(0, 8)}`,
    type: CELL_SERVICE_TYPE,
    port,
    txt: { cell: cellId, feed: feedKey },
  });
  const browser = bonjour.find({ type: CELL_SERVICE_TYPE });
  browser.on("up", (s: BrowsedService) => {
    const txt = (s.txt ?? {}) as Record<string, string>;
    if (txt["cell"] !== cellId) return; // a different cell
    const peer = txt["feed"];
    if (!peer || peer === feedKey) return; // skip self / untagged
    onPeerFeed(peer);
  });
  return {
    stop: () => {
      try {
        service.stop?.();
      } catch {
        /* already down */
      }
      try {
        browser.stop();
      } catch {
        /* already down */
      }
      try {
        bonjour.destroy();
      } catch {
        /* already destroyed */
      }
    },
  };
}

/** Start advertising + browsing. `selfKey` is filtered out of the browse results. */
export function startDiscovery(advertise: DiscoveryAdvertise, selfKey: string): DiscoveryHandle {
  const bonjour = new Bonjour();
  const service = bonjour.publish({
    name: advertise.name,
    type: SERVICE_TYPE,
    port: advertise.port,
    txt: { key: advertise.deviceKey, fp: advertise.fp, class: advertise.computeClass, ram: String(advertise.ramMB) },
  });

  const found = new Map<string, DiscoveredDevice>();
  const onUp = (s: BrowsedService): void => {
    const txt = (s.txt ?? {}) as Record<string, string>;
    const key = txt["key"];
    if (!key || key === selfKey) return; // skip self + untagged
    found.set(key, {
      deviceKey: key,
      name: s.name ?? "device",
      computeClass: txt["class"] ?? "?",
      ramMB: Number(txt["ram"] ?? 0),
      host: firstIpv4(s),
      port: s.port,
      fp: txt["fp"] ?? "",
    });
  };
  const onDown = (s: BrowsedService): void => {
    const key = ((s.txt ?? {}) as Record<string, string>)["key"];
    if (key) found.delete(key);
  };

  const browser = bonjour.find({ type: SERVICE_TYPE });
  browser.on("up", onUp);
  browser.on("down", onDown);

  return {
    list: () => [...found.values()],
    stop: () => {
      try {
        service.stop?.();
      } catch {
        /* already down */
      }
      try {
        browser.stop();
      } catch {
        /* already down */
      }
      try {
        bonjour.destroy();
      } catch {
        /* already destroyed */
      }
    },
  };
}
