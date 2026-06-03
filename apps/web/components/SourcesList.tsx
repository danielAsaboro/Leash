import type { Source } from "../lib/db.ts";

/**
 * The SOURCES rail. Numbered to match the body's `[Source N]` chips (the chips link
 * to these `#source-N` anchors). External links open out; private-graph sources show
 * their kind instead.
 */
export function SourcesList({ sources }: { sources: Source[] }) {
  return (
    <section aria-labelledby="sources-h">
      <h2 id="sources-h" className="kicker mb-3 pb-2" style={{ borderBottom: "2px solid var(--color-ink)", color: "var(--color-ink)" }}>
        Sources
      </h2>
      <ol className="space-y-3">
        {sources.map((s, i) => (
          <li key={s.id} id={`source-${i + 1}`} className="scroll-mt-24 flex gap-3">
            <span
              className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
              style={{ background: "var(--color-ink)", color: "var(--color-cream)", fontFamily: "var(--font-mono)", fontSize: "0.62rem", fontWeight: 600 }}
            >
              {i + 1}
            </span>
            <div className="min-w-0">
              {s.url ? (
                <a
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                  className="block transition-colors hover:opacity-70"
                  style={{ fontFamily: "var(--font-body)", fontWeight: 500, lineHeight: 1.3 }}
                >
                  {s.label} <span style={{ color: "var(--color-sage-deep)" }}>↗</span>
                </a>
              ) : (
                <span style={{ fontFamily: "var(--font-body)", fontWeight: 500, lineHeight: 1.3 }}>{s.label}</span>
              )}
              {s.kind && (
                <span className="kicker mt-0.5 block" style={{ color: "var(--color-faint)" }}>
                  {s.kind}
                </span>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
