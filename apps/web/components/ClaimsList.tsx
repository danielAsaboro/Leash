import type { Claim } from "../lib/db.ts";

const TONE: Record<string, { dot: string; label: string }> = {
  UNVERIFIED: { dot: "var(--color-brick)", label: "Unverified" },
  CONFLICTED: { dot: "var(--color-brick)", label: "Conflicted" },
  VERIFIED: { dot: "var(--color-sage)", label: "Verified" },
};

/**
 * The UNVERIFIED CLAIMS rail — the council critic's output. Each claim carries a
 * brick-red rule and the reviewer's note, so the reader sees exactly what still
 * needs a primary confirmation. This honesty is the point of a private paper.
 */
export function ClaimsList({ claims }: { claims: Claim[] }) {
  if (claims.length === 0) return null;
  const unresolved = claims.filter((c) => c.status !== "VERIFIED").length;
  return (
    <section aria-labelledby="claims-h" className="mt-9">
      <h2
        id="claims-h"
        className="kicker mb-3 flex items-center justify-between pb-2"
        style={{ borderBottom: "2px solid var(--color-brick)", color: "var(--color-brick)" }}
      >
        <span>Unverified Claims</span>
        {unresolved > 0 && <span>{unresolved}</span>}
      </h2>
      <ul className="space-y-4">
        {claims.map((c) => {
          const tone = TONE[c.status] ?? TONE.UNVERIFIED!;
          return (
            <li key={c.id} className="pl-3" style={{ borderLeft: `2px solid ${tone.dot}` }}>
              <div className="flex items-center gap-2">
                <span
                  className="kicker"
                  style={{ color: c.status === "VERIFIED" ? "var(--color-sage-deep)" : "var(--color-brick)" }}
                >
                  {tone.label}
                </span>
              </div>
              <p className="mt-1" style={{ fontFamily: "var(--font-body)", lineHeight: 1.4, color: "var(--color-ink)" }}>
                {c.text}
              </p>
              <p className="mt-1 italic" style={{ color: "var(--color-muted)", fontSize: "0.92rem" }}>
                {c.note}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
