"use client";

/**
 * SelfNode — this device at the center of the mesh. The hub every wire fans out from. Shows the
 * live mesh id, how many peers it sees, total in-flight delegations across the mesh, and whether
 * a payout wallet is bound. Its halo brightens whenever any route is in flight (`busy`).
 */
import { Handle, Position, type NodeProps } from "@xyflow/react";

export interface SelfNodeData {
  meshId: string | null;
  meshLabel: string;
  peerCount: number;
  liveCount: number;
  totalInflight: number;
  wallet: string | null;
  busy: boolean;
  [key: string]: unknown;
}

export function SelfNode({ data }: NodeProps) {
  const { meshId, meshLabel, peerCount, liveCount, totalInflight, wallet, busy } = data as SelfNodeData;

  return (
    <div className={`mesh-node mesh-self ${busy ? "is-busy" : ""}`}>
      <Handle type="source" position={Position.Top} className="mesh-handle" isConnectable={false} />
      <Handle type="target" position={Position.Top} id="t" className="mesh-handle" isConnectable={false} />
      <div className="mesh-self-halo" aria-hidden />

      <span className="mesh-self-kicker">this device</span>
      <span className="mesh-self-name">{meshLabel || "Mesh"}</span>
      <span className="mesh-self-mesh">{meshId ? `mesh ${meshId}` : "no mesh"}</span>

      <div className="mesh-self-stats">
        <div className="mesh-stat">
          <span className="mesh-stat-num">{liveCount}<span className="mesh-stat-den">/{peerCount}</span></span>
          <span className="mesh-stat-lab">peers live</span>
        </div>
        <div className="mesh-stat">
          <span className="mesh-stat-num" style={{ color: totalInflight > 0 ? "var(--mesh-glow)" : undefined }}>{totalInflight}</span>
          <span className="mesh-stat-lab">in-flight</span>
        </div>
      </div>

      <span className="mesh-self-wallet">{wallet ? `payout ${wallet.slice(0, 6)}…${wallet.slice(-4)}` : "no payout rail"}</span>
    </div>
  );
}
