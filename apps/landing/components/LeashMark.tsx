import {
  LEASH_MARK_CUTOUT,
  LEASH_MARK_LINKS,
  LEASH_MARK_NODES,
  LEASH_MARK_STROKE,
  LEASH_MARK_VIEWBOX,
} from "./leash-mark.ts";

type LeashMarkProps = {
  className?: string;
  cutoutColor?: string;
  title?: string;
};

export function LeashMark({ className, cutoutColor = "var(--color-cream)", title }: LeashMarkProps) {
  return (
    <svg
      viewBox={`0 0 ${LEASH_MARK_VIEWBOX} ${LEASH_MARK_VIEWBOX}`}
      className={className}
      fill="none"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      <g
        fill="currentColor"
        stroke="currentColor"
        strokeWidth={LEASH_MARK_STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {LEASH_MARK_LINKS.map((link) => (
          <line key={`${link.x1}-${link.y1}-${link.x2}-${link.y2}`} {...link} />
        ))}
        {LEASH_MARK_NODES.map((node) => (
          <circle key={`${node.cx}-${node.cy}`} {...node} />
        ))}
      </g>
      <circle {...LEASH_MARK_CUTOUT} fill={cutoutColor} />
    </svg>
  );
}
