/**
 * `/mesh` — the mesh picker. A device can belong to several meshes (primary, joined, public),
 * so the index lists them; the live monitor lives at `/mesh/<meshId>`. All real: the cards come
 * from the daemon's mesh memberships. Daemon-down and no-meshes are surfaced honestly.
 */
import Link from "next/link";
import { MeshShell } from "../../components/mesh/MeshShell.tsx";
import { meshList } from "../../lib/leash/mesh.server.ts";
import "./mesh.css";

export const dynamic = "force-dynamic";

export default async function MeshIndexPage() {
  const { reachable, error, meshes } = await meshList();

  return (
    <MeshShell title="The Fabric">
      <div className="mesh-index">
        {!reachable ? (
          <div className="mesh-index-note">
            <p className="mesh-overlay-title">Mesh daemon offline</p>
            <p className="mesh-overlay-body">{error}</p>
            <p className="mesh-overlay-hint">Start Hypha on the Services page, then your meshes appear here.</p>
          </div>
        ) : meshes.length === 0 ? (
          <div className="mesh-index-note">
            <p className="mesh-overlay-title">No meshes yet</p>
            <p className="mesh-overlay-body">This device hasn&apos;t paired into a mesh. Pair another Mac in Settings → Devices to found one.</p>
          </div>
        ) : (
          <>
            <p className="mesh-index-lede">{meshes.length} mesh{meshes.length === 1 ? "" : "es"} on this device — open one to watch it live.</p>
            <ul className="mesh-card-grid">
              {meshes.map((m) => (
                <li key={m.meshId}>
                  <Link href={`/mesh/${encodeURIComponent(m.meshId)}`} className="mesh-card">
                    <div className="mesh-card-top">
                      <span className="mesh-card-name">{m.label || m.meshId.slice(0, 10)}</span>
                      <span className={`mesh-card-vis is-${m.visibility ?? "private"}`}>{m.visibility ?? "private"}</span>
                    </div>
                    <span className="mesh-card-id">{m.meshId.slice(0, 16)}</span>
                    <div className="mesh-card-foot">
                      <span><strong>{m.peers ?? 0}</strong> peer{(m.peers ?? 0) === 1 ? "" : "s"}</span>
                      {m.creator && <span className="mesh-card-tag">founder</span>}
                      {m.writable === false && <span className="mesh-card-tag is-dim">syncing</span>}
                      <span className="mesh-card-go">open ›</span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </MeshShell>
  );
}
