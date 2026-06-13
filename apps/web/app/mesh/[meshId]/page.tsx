/**
 * `/mesh/<meshId>` — the live monitor for ONE mesh. Access is decided server-side:
 *   • a mesh this device belongs to (private or public) renders;
 *   • an unknown / non-member id is forbidden ("private / not on this device");
 *   • daemon-down can't be verified, so we render the canvas and let it show its offline state.
 * The canvas scopes its topology + activity to this meshId.
 */
import { MeshShell } from "../../../components/mesh/MeshShell.tsx";
import { MeshCanvas } from "../../../components/mesh/MeshCanvas.tsx";
import { resolveMeshAccess } from "../../../lib/leash/mesh.server.ts";
import "../mesh.css";

export const dynamic = "force-dynamic";

export default async function MeshDetailPage({ params }: { params: Promise<{ meshId: string }> }) {
  const { meshId } = await params;
  const access = await resolveMeshAccess(meshId);

  if (access.kind === "forbidden") {
    return (
      <MeshShell title="Private mesh" back={{ href: "/mesh", label: "all meshes" }}>
        <div className="mesh-overlay mesh-overlay-soft" style={{ alignItems: "center", paddingBottom: 0 }}>
          <div className="mesh-overlay-card">
            <span className="mesh-dot" style={{ background: "var(--color-brick)" }} />
            <p className="mesh-overlay-title">This mesh is private</p>
            <p className="mesh-overlay-body">
              <code>{meshId.slice(0, 18)}</code> isn&apos;t a mesh this device belongs to. Private meshes are only viewable
              from a member device.
            </p>
            <p className="mesh-overlay-hint">If this is your mesh, pair this device into it first.</p>
          </div>
        </div>
      </MeshShell>
    );
  }

  const label = access.kind === "ok" ? access.mesh.label || meshId.slice(0, 10) : meshId.slice(0, 10);
  const visibility = access.kind === "ok" ? access.mesh.visibility ?? "private" : undefined;

  return (
    <MeshShell title={label} kicker={`Mesh · ${meshId.slice(0, 12)}`} legend back={{ href: "/mesh", label: "all meshes" }}>
      <MeshCanvas meshId={meshId} meshLabel={label} visibility={visibility} />
    </MeshShell>
  );
}
