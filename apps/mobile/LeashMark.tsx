import React from "react";
import Svg, { Circle, Line, Rect } from "react-native-svg";
import { C } from "./theme";

/**
 * The Leash mark — three mesh nodes joined into a triangle with a cut-out centre, the
 * same geometry as the web/desktop brand (apps/web/lib/brand/leash-mark.ts). A device
 * mesh holding a single private mind.
 */
const VIEWBOX = 64;
const STROKE = 11;
const NODES = [
  { cx: 32, cy: 15, r: 9 },
  { cx: 18, cy: 42, r: 9 },
  { cx: 46, cy: 42, r: 9 },
];
const LINKS = [
  { x1: 32, y1: 20, x2: 20.5, y2: 36.5 },
  { x1: 32, y1: 20, x2: 43.5, y2: 36.5 },
  { x1: 24, y1: 42, x2: 40, y2: 42 },
];
const CUTOUT = { cx: 32, cy: 31.5, r: 4.75 };

export function LeashMark({
  size = 24,
  mark = C.cream,
  cutout,
  tile,
  radius = 14,
}: {
  size?: number;
  mark?: string;
  cutout?: string;
  tile?: string;
  radius?: number;
}) {
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`} fill="none">
      {tile && <Rect width={VIEWBOX} height={VIEWBOX} rx={radius} fill={tile} />}
      {LINKS.map((l, i) => (
        <Line key={i} {...l} stroke={mark} strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
      ))}
      {NODES.map((n, i) => (
        <Circle key={i} {...n} fill={mark} />
      ))}
      <Circle {...CUTOUT} fill={cutout ?? tile ?? C.cream} />
    </Svg>
  );
}
