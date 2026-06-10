import type { MeshStatus, MeshPeer, MeshMembership } from "../lib/leash/hypha.ts";
import { ForgetPeerButton, ClearStaleButton, RestorePeerButton } from "./MeshPeerActions.tsx";

/**
 * The Hypha card's body: paired mesh peers GROUPED BY MESH (label · type · tier · writability),
 * plus the broker's borrow counters. Server component — data fetched on the /services page.
 * Failures are surfaced (the never-silent-catch rule), never hidden behind an empty list.
 */

function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function PeerRow({ p }: { p: MeshPeer }) {
  return (
    <li className="border p-3" style={{ borderColor: "var(--color-rule)", background: "var(--color-cream)" }}>
      <div className="flex flex-wrap items-center gap-2.5">
        <span aria-hidden className="inline-block h-2 w-2 rounded-full" title={p.live ? "live (heartbeat fresh)" : "stale"} style={{ background: p.live ? "var(--color-sage)" : "var(--color-faint)" }} />
        <span className="kicker kicker-sage">{p.displayName}</span>
        <span className="kicker" style={{ color: "var(--color-faint)" }}>
          {p.computeClass} · {Math.round(p.ramMB / 1024)}GB · {p.powerState}
          {p.inflight > 0 ? ` · ${p.inflight} in flight` : ""} · seen {ago(p.lastSeen)}
          {!p.live ? " · stale" : ""}
        </span>
        <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
        <ForgetPeerButton deviceKey={p.deviceId} name={p.displayName} />
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {p.models.length === 0 && (
          <span className="kicker" style={{ color: "var(--color-faint)" }}>
            no chat models advertised
          </span>
        )}
        {p.models.map((m) => {
          const warm = p.warmModels.includes(m);
          return (
            <span
              key={m}
              className="kicker px-2 py-0.5"
              title={warm ? "warm — pre-loaded, ready for instant overflow" : "advertised — not yet pre-warmed"}
              style={warm ? { background: "var(--color-sage-deep)", color: "var(--color-cream)" } : { border: "1px solid var(--color-rule-strong)", color: "var(--color-muted)" }}
            >
              {warm ? "● " : "○ "}
              {m}
            </span>
          );
        })}
      </div>
    </li>
  );
}

/** A small badge for a mesh's visibility (private = closed devices, public = open cell). */
function VisBadge({ visibility }: { visibility: string }) {
  const isPublic = visibility === "public";
  return (
    <span
      className="kicker px-1.5 py-0.5"
      title={isPublic ? "public — open, discoverable cell" : "private — your own allow-listed devices"}
      style={isPublic ? { background: "var(--color-brick)", color: "var(--color-cream)" } : { border: "1px solid var(--color-rule-strong)", color: "var(--color-muted)" }}
    >
      {isPublic ? "public" : "private"}
    </span>
  );
}

export function HyphaPeersSection({ status }: { status: MeshStatus }) {
  const { peers, borrow, forgotten, meshes, error } = status;
  const staleCount = peers.filter((p) => !p.live).length;

  // Group peers under their mesh. A pre-multi-mesh daemon (no `meshes`, peers carry no meshId)
  // → a single untitled group, so old daemons still render.
  const groups: Array<{ mesh: MeshMembership | null; peers: MeshPeer[] }> =
    meshes.length > 0
      ? [...meshes].sort((a, b) => a.tier - b.tier).map((m) => ({ mesh: m, peers: peers.filter((p) => p.meshId === m.meshId) }))
      : [{ mesh: null, peers }];

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="kicker" style={{ color: "var(--color-faint)" }}>
          Mesh peers
        </span>
        {staleCount > 0 && <ClearStaleButton count={staleCount} />}
        <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
        {borrow && (
          <span className="kicker" style={{ color: "var(--color-faint)" }}>
            borrowed: {borrow.shed} shed · {borrow.availabilityRouted} routed
            {borrow.overflowFailures > 0 ? ` · ${borrow.overflowFailures} fell back` : ""}
          </span>
        )}
      </div>

      {error && (
        <p className="kicker mt-2" style={{ color: "var(--color-brick)" }} role="alert">
          {error}
        </p>
      )}

      {!error && peers.length === 0 && meshes.length === 0 && (
        <p className="mt-2" style={{ color: "var(--color-muted)", fontSize: "0.82rem", fontFamily: "var(--font-body)" }}>
          No peers paired yet. Use <strong>Add a device</strong> (a nearby device on your network) or <strong>New mesh</strong> above.
        </p>
      )}

      {groups.map(({ mesh, peers: gp }) => (
        <div key={mesh?.meshId ?? "_default"} className="mt-3">
          {mesh && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="kicker kicker-sage">{mesh.label}</span>
              <VisBadge visibility={mesh.visibility} />
              <span className="kicker" style={{ color: "var(--color-faint)" }} title={mesh.writable ? "this device can manage this mesh" : "read-only until this mesh re-syncs this device's write access"}>
                tier {mesh.tier} · {mesh.writable ? "writable ✓" : "syncing…"} · {gp.length} peer{gp.length === 1 ? "" : "s"}
              </span>
              <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
            </div>
          )}
          {gp.length === 0 ? (
            <p className="kicker mt-1.5" style={{ color: "var(--color-faint)" }}>
              no peers in this mesh yet — add one above
            </p>
          ) : (
            <ul className="mt-2 flex flex-col gap-2">
              {gp.map((p) => (
                <PeerRow key={p.deviceId} p={p} />
              ))}
            </ul>
          )}
        </div>
      ))}

      {forgotten.length > 0 && (
        <div className="mt-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="kicker" style={{ color: "var(--color-faint)" }}>
              Disconnected devices
            </span>
            <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
          </div>
          <ul className="mt-2 flex flex-col gap-2">
            {forgotten.map((key) => (
              <li key={key} className="flex flex-wrap items-center gap-2.5 border p-3" style={{ borderColor: "var(--color-rule)", background: "var(--color-cream)" }}>
                <span aria-hidden className="inline-block h-2 w-2 rounded-full" title="disconnected (tombstoned on this device)" style={{ background: "var(--color-brick)" }} />
                <span className="kicker" style={{ fontFamily: "var(--font-mono)" }} title={key}>
                  {key.slice(0, 16)}…
                </span>
                <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
                <RestorePeerButton deviceKey={key} />
              </li>
            ))}
          </ul>
          <p className="mt-1.5" style={{ color: "var(--color-faint)", fontSize: "0.78rem", fontFamily: "var(--font-body)" }}>
            Restore un-hides the device on this end; for full two-way reconnection, re-pair via &ldquo;Add a device&rdquo;.
          </p>
        </div>
      )}
    </div>
  );
}
