"use client";

import { useMemo, useState } from "react";
import type { KitRole } from "../../lib/leash/kit.ts";

function fmtBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}

export function DownloadDisclosure({ roles }: { roles: KitRole[] }) {
  const [open, setOpen] = useState(false);
  const total = useMemo(() => roles.reduce((sum, role) => sum + (role.bytes || 0), 0), [roles]);

  return (
    <section
      className="rounded-[6px] border p-4"
      style={{ borderColor: "var(--color-rule)", background: "var(--color-paper)" }}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-4 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        style={{ outlineColor: "var(--color-sage-deep)" }}
        aria-expanded={open}
      >
        <div>
          <div className="kicker kicker-sage">Setup downloads</div>
          <p style={{ color: "var(--color-ink-soft)" }}>
            {roles.length} local assets · {fmtBytes(total)}
          </p>
        </div>
        <span className="kicker">{open ? "Hide" : "Show"}</span>
      </button>

      {open && (
        <ul className="mt-4 space-y-3">
          {roles.map((role) => (
            <li
              key={`${role.role}-${role.alias}`}
              className="grid gap-1 border-t pt-3 first:border-t-0 first:pt-0"
              style={{ borderColor: "var(--color-rule)" }}
            >
              <div className="flex items-baseline justify-between gap-4">
                <span style={{ fontFamily: "var(--font-display)", fontWeight: 700 }}>{role.alias}</span>
                <span className="kicker">{fmtBytes(role.bytes)}</span>
              </div>
              <p className="kicker" style={{ color: "var(--color-faint)" }}>
                {role.role.replaceAll("_", " ")}
              </p>
              <p style={{ color: "var(--color-ink-soft)", fontSize: "0.96rem", lineHeight: 1.45 }}>{role.powers}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
