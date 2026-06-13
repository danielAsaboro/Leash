/**
 * Floating-edge geometry. For a radial mesh (hub centered, peers on a ring) a wire must leave
 * each node from whichever side faces its partner — not a fixed handle. These helpers compute
 * the point where the straight line between two node centers crosses each node's border, so the
 * bezier wires meet the cards cleanly from any angle. Adapted from React Flow's floating-edge example.
 */
import type { InternalNode, Node, Position } from "@xyflow/react";
import { Position as Pos } from "@xyflow/react";

interface XY {
  x: number;
  y: number;
}

/** Where the center→center line crosses `node`'s rectangle border. */
function intersection(node: InternalNode<Node>, target: XY): XY {
  const { width = 0, height = 0 } = node.measured;
  const x2 = node.internals.positionAbsolute.x + width / 2;
  const y2 = node.internals.positionAbsolute.y + height / 2;
  const w = width / 2;
  const h = height / 2;

  const dx = target.x - x2;
  const dy = target.y - y2;
  if (dx === 0 && dy === 0) return { x: x2, y: y2 };
  // Scale the direction vector to the nearer of the two border planes.
  const scale = Math.min(w / Math.abs(dx || 1e-6), h / Math.abs(dy || 1e-6));
  return { x: x2 + dx * scale, y: y2 + dy * scale };
}

/** Which side of `node` the point `p` sits on — picks the bezier control direction. */
function sideOf(node: InternalNode<Node>, p: XY): Position {
  const { width = 0, height = 0 } = node.measured;
  const nx = node.internals.positionAbsolute.x;
  const ny = node.internals.positionAbsolute.y;
  const px = Math.round(p.x - nx);
  const py = Math.round(p.y - ny);
  if (px <= 1) return Pos.Left;
  if (px >= Math.round(width) - 1) return Pos.Right;
  if (py <= 1) return Pos.Top;
  return Pos.Bottom;
}

function center(node: InternalNode<Node>): XY {
  const { width = 0, height = 0 } = node.measured;
  return {
    x: node.internals.positionAbsolute.x + width / 2,
    y: node.internals.positionAbsolute.y + height / 2,
  };
}

/** Endpoint coordinates + sides for a floating bezier between two nodes. */
export function getEdgeParams(source: InternalNode<Node>, target: InternalNode<Node>) {
  const s = intersection(source, center(target));
  const t = intersection(target, center(source));
  return {
    sx: s.x,
    sy: s.y,
    tx: t.x,
    ty: t.y,
    sourcePos: sideOf(source, s),
    targetPos: sideOf(target, t),
  };
}
