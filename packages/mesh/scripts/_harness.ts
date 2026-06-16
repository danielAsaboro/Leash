/**
 * Test harness for the task-sync tsx script: two writable MeshGraphs replicating over a
 * loopback pipe, with no swarm and no network — so the convergence/LWW/leader assertions
 * run on this Mac with no device.
 *
 * Built on the proven offline path (cf. scripts/smoke-multi-mesh.ts + spike/05-autobase-pairing.ts):
 *   - host A founds PRIMARY (writable); host B bootstraps to A's autobase (read-only at first);
 *   - one loopback pipe over the two ROOT stores carries every core (what the shared swarm does);
 *   - A emits an `add-writer` for B's local writer key (the existing pairing→add-writer Entry),
 *     which replicates to B; we pump update() on both until B.writable — NO swarm, NO blind-pairing.
 * The returned graphs are BOTH writable, so the test can publishTask/advertise on either side.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import b4a from "b4a";
import { MeshGraph, MeshHost, PRIMARY_MESH_ID } from "../src/index.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface PairedGraphs {
  a: MeshGraph;
  b: MeshGraph;
  close: () => Promise<void>;
}

/**
 * Stand up two writable MeshGraphs (A and B) joined to ONE mesh, replicating over loopback.
 * Both are writable on return (B promoted via the offline add-writer path).
 */
export async function makePairedGraphs(): Promise<PairedGraphs> {
  const root = mkdtempSync(join(tmpdir(), "mesh-task-sync-" + randomUUID().slice(0, 8) + "-"));
  const dirA = join(root, "hostA");
  const dirB = join(root, "hostB");

  const hostA = await MeshHost.open({ rootDir: dirA, swarm: false });
  const { graph: a } = await hostA.openMesh({ meshId: PRIMARY_MESH_ID });

  const hostB = await MeshHost.open({ rootDir: dirB, swarm: false });
  const { graph: b } = await hostB.openMesh({ meshId: PRIMARY_MESH_ID, bootstrapKey: b4a.from(a.autobaseKey, "hex") });

  // ONE loopback pipe over the ROOT stores carries every namespace/core (cf. smoke-multi-mesh).
  const sa = hostA.replicate(true) as Duplex;
  const sb = hostB.replicate(false) as Duplex;
  sa.pipe(sb).pipe(sa);

  // Promote B to a writer: A appends the add-writer record; it replicates to B; pump until writable.
  await a.addWriter(b.localWriterKey);
  const t0 = Date.now();
  while (!b.writable) {
    if (Date.now() - t0 > 20_000) throw new Error("harness: B was not promoted to a writer within 20s");
    await a.update();
    await b.update();
    await sleep(150);
  }

  const close = async () => {
    try { sa.destroy(); } catch { /* already gone */ }
    try { sb.destroy(); } catch { /* already gone */ }
    await hostA.close().catch(() => undefined);
    await hostB.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  };

  return { a, b, close };
}
