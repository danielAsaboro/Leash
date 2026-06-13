"use client";

/**
 * DeviceNode — one peer device card. Echoes the dark node-graph-editor look (rounded slab, mono
 * header label, a connector dot) but every value is real PeerView telemetry: compute class, RAM,
 * power state, served + warm models, in-flight count, last-seen. The status ring is derived, not
 * decorative: offline (dim, dashed) / idle (sage) / warm (sage, model pre-loaded) / running
 * (amber, pulsing — inflight or a live route) / failed (brick flash).
 */
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { NodeStatus, PeerView } from "./types.ts";

export interface DeviceNodeData {
  peer: PeerView;
  status: NodeStatus;
  /** Tail of the most recent routing event touching this node, for the live caption. */
  lastEvent?: { kind: string; alias?: string; tokens?: number; ms?: number; error?: string };
  [key: string]: unknown;
}

const STATUS_META: Record<NodeStatus, { label: string; color: string }> = {
  offline: { label: "offline", color: "var(--mesh-faint)" },
  idle: { label: "idle", color: "var(--mesh-sage)" },
  warm: { label: "warm", color: "var(--mesh-sage)" },
  running: { label: "running", color: "var(--mesh-glow)" },
  failed: { label: "fault", color: "var(--mesh-brick)" },
};

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export function DeviceNode({ data }: NodeProps) {
  const { peer, status, lastEvent } = data as DeviceNodeData;
  const meta = STATUS_META[status];
  const offline = status === "offline";
  const running = status === "running";
  const ramGB = peer.ramMB ? `${(peer.ramMB / 1024).toFixed(0)} GB` : "—";

  return (
    <div className={`mesh-node mesh-device is-${status}`} style={{ ["--ring" as string]: meta.color }}>
      <Handle type="source" position={Position.Top} className="mesh-handle" isConnectable={false} />
      <Handle type="target" position={Position.Top} id="t" className="mesh-handle" isConnectable={false} />

      <header className="mesh-node-head">
        <span className={`mesh-dot ${running ? "is-pulse" : ""}`} style={{ background: meta.color }} />
        <span className="mesh-node-name">{peer.displayName || peer.deviceId.slice(0, 8)}</span>
        <span className="mesh-node-status" style={{ color: meta.color }}>{meta.label}</span>
      </header>

      <div className="mesh-node-body">
        <div className="mesh-spec">
          <span>{peer.computeClass || "device"}</span>
          <span className="mesh-spec-sep">·</span>
          <span>{ramGB}</span>
          <span className="mesh-spec-sep">·</span>
          <span>{peer.powerState || "—"}</span>
        </div>

        {peer.models.length > 0 && (
          <div className="mesh-chips">
            {peer.models.slice(0, 4).map((m) => (
              <span key={m} className={`mesh-chip ${peer.warmModels.includes(m) ? "is-warm" : ""}`}>
                {m}
              </span>
            ))}
            {peer.models.length > 4 && <span className="mesh-chip is-more">+{peer.models.length - 4}</span>}
          </div>
        )}

        <footer className="mesh-node-foot">
          {running ? (
            <span className="mesh-foot-live">
              {peer.inflight > 0 ? `${peer.inflight} in-flight` : "routing"}
              {lastEvent?.alias ? ` · ${lastEvent.alias}` : ""}
              {lastEvent?.tokens ? ` · ${lastEvent.tokens} tok` : ""}
            </span>
          ) : status === "failed" ? (
            <span className="mesh-foot-fail">{lastEvent?.error ? lastEvent.error.slice(0, 36) : "delegation failed"}</span>
          ) : offline ? (
            <span className="mesh-foot-dim">last seen {relTime(peer.lastSeen)}</span>
          ) : (
            <span className="mesh-foot-dim">
              {peer.warmModels.length > 0 ? `${peer.warmModels.length} warm` : "ready"} · seen {relTime(peer.lastSeen)}
            </span>
          )}
        </footer>
      </div>
    </div>
  );
}
