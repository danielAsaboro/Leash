/**
 * MeshShell — the shared chrome for every `/mesh` surface (index picker, per-mesh monitor,
 * forbidden state). The fixed cream control surface + HUD header, in the broadsheet tokens.
 * Server-renderable; the live canvas mounts as a child.
 */
import Link from "next/link";
import type { ReactNode } from "react";

const LEGEND: { label: string; cls: string }[] = [
  { label: "running", cls: "running" },
  { label: "warm", cls: "warm" },
  { label: "idle", cls: "idle" },
  { label: "offline", cls: "offline" },
  { label: "fault", cls: "failed" },
];

export function MeshShell({
  kicker = "Mycelium · Mesh Monitor",
  title,
  legend = false,
  back,
  right,
  children,
}: {
  kicker?: string;
  title: string;
  legend?: boolean;
  back?: { href: string; label: string };
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mesh-monitor">
      <header className="mesh-hud">
        <div className="mesh-hud-title">
          <span className="mesh-hud-kicker">{kicker}</span>
          <h1 className="mesh-hud-h1">{title}</h1>
          {back && (
            <Link href={back.href} className="mesh-hud-back">
              ‹ {back.label}
            </Link>
          )}
        </div>
        {legend ? (
          <ul className="mesh-legend" aria-label="node status legend">
            {LEGEND.map((l) => (
              <li key={l.cls} className="mesh-legend-item">
                <span className={`mesh-dot is-legend is-${l.cls}`} />
                {l.label}
              </li>
            ))}
          </ul>
        ) : (
          right
        )}
      </header>
      {children}
    </div>
  );
}
