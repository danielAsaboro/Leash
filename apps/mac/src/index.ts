/**
 * Layer 5 — Mac app / dashboard entry. STUB.
 *
 * Will become the hub: hosts the delegated-inference provider, runs the nightly
 * LoRA, and serves the dashboard that visualizes the living mesh (which device is
 * sensing / thinking / learning) + the growth chart. Wired up only after the
 * spike gate is GO.
 */
import { createLogger } from "@mycelium/shared";
import { LAYER as MESH } from "@mycelium/mesh";
import { LAYER as SENSES } from "@mycelium/senses";
import { LAYER as MIND } from "@mycelium/mind";
import { LAYER as MEMORY } from "@mycelium/memory";

const log = createLogger("mac");

function main(): void {
  log.info("Mycelium Mac hub — scaffold only.");
  log.info(`layers wired: ${[MESH, SENSES, MIND, MEMORY].join(" → ")}`);
  log.info("Gate: run the spike (npm run spike:*) before building features. See SPIKE_RESULTS.md.");
}

main();
