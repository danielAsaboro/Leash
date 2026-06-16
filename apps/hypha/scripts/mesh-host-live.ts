/**
 * Live desktop mesh host for the on-device phone test (NOT a unit test): opens a real MeshHost on
 * its own Hyperswarm, mints a blind-pairing invite to paste into the phone, seeds a task
 * (desktop → phone), and every 3s prints the replicated task set + peer/writer count (phone →
 * desktop). The same @mycelium/mesh MeshHost the hypha daemon uses — just без the SDK provider, so
 * it boots fast for an interactive pairing test. Ctrl-C to stop.
 *
 *   npx tsx apps/hypha/scripts/mesh-host-live.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeshHost, PRIMARY_MESH_ID } from "@mycelium/mesh";

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "mesh-host-live-"));
  const host = await MeshHost.open({ rootDir: dir, swarm: true });
  const { graph } = await host.openMesh({ meshId: PRIMARY_MESH_ID });
  const now = Date.now();
  const selfCap = () => ({
    deviceId: graph.localWriterKey,
    displayName: "DesktopHost",
    computeClass: "laptop" as const,
    isProvider: false,
    joinedAt: now - 100_000, // older than the phone → desktop is the leader unless it goes stale
    ramMB: 0,
    powerState: "pluggedIn" as const,
    availableModels: [] as string[],
    lastSeen: new Date().toISOString(),
  });
  await graph.advertise(selfCap() as never);

  const invite = await graph.mintInvite();
  console.log("\n================ PASTE THIS INVITE INTO THE PHONE (Mesh tab → Join a mesh) ================\n");
  console.log(invite);
  console.log("\n==========================================================================================\n");

  // Seed a task so the phone shows desktop→phone replication the moment it joins.
  await graph.publishTask({ id: "desk-1", title: "Hello from the desktop 👋", status: "open", priority: "normal", tags: [], source: "user", createdAt: now, updatedAt: now });
  console.log("seeded task desk-1; watching for the phone to join + sync…\n");

  setInterval(async () => {
    try {
      await graph.advertise(selfCap() as never); // refresh lastSeen (liveness)
      await graph.update();
      const tasks = await graph.tasks();
      const caps = await graph.capabilities();
      console.log(`[${new Date().toLocaleTimeString()}] writers=${graph.writerCount()} peers=${graph.peerCount} caps=${caps.length} tasks=${tasks.length}: ${tasks.map((t) => `${t.id}:"${t.title}"`).join("  ")}`);
    } catch (e) {
      console.error("loop error:", e);
    }
  }, 3000);
}
main().catch((e) => { console.error("host failed:", e); process.exit(1); });
