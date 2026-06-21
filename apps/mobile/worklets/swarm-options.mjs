export function forceRelayConnect(swarm) {
  const dht = swarm?.dht;
  if (!dht || typeof dht.connect !== "function") return false;
  if (dht.__leashForceRelayConnect) return true;
  const origConnect = dht.connect.bind(dht);
  dht.connect = (key, opts) => origConnect(key, { ...opts, localConnection: false });
  try {
    Object.defineProperty(dht, "__leashForceRelayConnect", { value: true });
  } catch {
    dht.__leashForceRelayConnect = true;
  }
  return true;
}
