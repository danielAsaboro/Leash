import Hyperswarm from "hyperswarm";
import { forceRelayConnect } from "./swarm-options.mjs";

export function createForwardSwarm(Swarm = Hyperswarm) {
  const swarm = new Swarm();
  forceRelayConnect(swarm);
  return swarm;
}
