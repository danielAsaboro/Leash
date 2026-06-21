"use client";

/**
 * MeshWire — the link between this device (hub) and a peer. A dim resting hairline that, the
 * instant a delegation routes to that peer, lights up: the wire brightens, its dashes start
 * marching toward the peer (the request), and a pulse travels the path. On `done` it settles
 * back; on `failed` it flashes brick. The animation is driven entirely by edge `data` the
 * canvas sets from the `/events` SSE — no fake traffic.
 */
import { BaseEdge, EdgeLabelRenderer, getBezierPath, useInternalNode, type EdgeProps } from "@xyflow/react";
import { getEdgeParams } from "./floating.ts";

export interface MeshWireData {
  /** active = a route is in flight; recently done; or failed. Drives color + motion. */
  state: "idle" | "active" | "done" | "failed";
  /** Short floating label shown mid-wire while active (e.g. "chat · 412 tok"). */
  note?: string;
  [key: string]: unknown;
}

const COLOR = {
  idle: "var(--mesh-wire)",
  active: "var(--mesh-glow)",
  done: "var(--mesh-sage)",
  failed: "var(--mesh-brick)",
} as const;

export function MeshWire({ id, source, target, markerEnd, data }: EdgeProps) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  if (!sourceNode || !targetNode) return null;

  const { sx, sy, tx, ty, sourcePos, targetPos } = getEdgeParams(sourceNode, targetNode);
  const [path, labelX, labelY] = getBezierPath({
    sourceX: sx,
    sourceY: sy,
    sourcePosition: sourcePos,
    targetPosition: targetPos,
    targetX: tx,
    targetY: ty,
    curvature: 0.35,
  });

  const d = (data ?? { state: "idle" }) as MeshWireData;
  const state = d.state;
  const live = state === "active";
  const color = COLOR[state];
  const width = live ? 2 : state === "idle" ? 1 : 1.5;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke: color,
          strokeWidth: width,
          strokeDasharray: "5 6",
          opacity: state === "idle" ? 0.4 : 0.95,
          filter: live ? "drop-shadow(0 0 5px var(--mesh-glow))" : "none",
          transition: "stroke 320ms ease, opacity 320ms ease, stroke-width 320ms ease",
        }}
        className={live ? "mesh-wire-active" : undefined}
      />
      {live && (
        // The request pulse, traveling hub → peer along the exact bezier.
        <circle r={3.4} fill="var(--mesh-glow)" style={{ filter: "drop-shadow(0 0 6px var(--mesh-glow))" }}>
          <animateMotion dur="1.05s" repeatCount="indefinite" path={path} keyPoints="0;1" keyTimes="0;1" calcMode="linear" />
        </circle>
      )}
      {d.note && state !== "idle" && (
        <EdgeLabelRenderer>
          <div
            className="mesh-wire-note"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, color }}
          >
            {d.note}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
