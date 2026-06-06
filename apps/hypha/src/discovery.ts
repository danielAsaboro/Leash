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
