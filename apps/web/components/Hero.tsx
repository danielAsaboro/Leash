import Link from "next/link";
import type { ArticleCard } from "../lib/queries.ts";
import { sectionKicker } from "../lib/ui.ts";

/**
 * The front-page lead. Oversized Fraunces headline beside the on-device hero image,
 * with a framed plate and a sage "Continue reading" affordance. The image is the
 * diffusion PNG the newsroom generated — real, local, offline.
 */
export function Hero({ article }: { article: ArticleCard }) {
  const href = `/${article.date}/${article.slug}`;
  return (
    <article className="rise grid grid-cols-1 gap-8 py-9 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
      <div className="order-2 lg:order-1">
        <div className="flex items-center gap-3">
          <span className="kicker kicker-sage">{sectionKicker(article.section, article.origin)}</span>
          <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
        </div>
        <Link href={href} className="group block">
          <h1
            className="mt-4 transition-colors group-hover:opacity-80"
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 900,
              lineHeight: 0.98,
              letterSpacing: "-0.015em",
              fontSize: "clamp(2.4rem, 5.2vw, 4.3rem)",
            }}
          >
            {article.headline}
          </h1>
        </Link>
        <p
          className="mt-5 italic"
          style={{ fontFamily: "var(--font-body)", fontSize: "1.3rem", lineHeight: 1.45, color: "var(--color-ink-soft)" }}
        >
          {article.dek}
        </p>
        <div className="mt-6 flex items-center gap-4">
          <Link href={href} className="kicker" style={{ color: "var(--color-sage-deep)" }}>
            Continue Reading →
          </Link>
          <span className="kicker">
            {article._count.sources} sources · {article._count.claims} claims
          </span>
        </div>
      </div>

      <div className="order-1 lg:order-2">
        <Link href={href} className="group block">
          <div
            className="relative overflow-hidden"
            style={{ border: "1px solid var(--color-rule-strong)", boxShadow: "0 18px 40px -24px rgba(25,23,18,0.45)" }}
          >
            {article.heroImagePath ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={article.heroImagePath}
                alt=""
                className="block aspect-[3/2] w-full object-cover transition-transform duration-700 group-hover:scale-[1.03]"
                style={{ filter: "saturate(0.92) contrast(1.02)" }}
              />
            ) : (
              <div className="flex aspect-[3/2] w-full items-center justify-center" style={{ background: "var(--color-paper)" }}>
                <span className="kicker">No plate</span>
              </div>
            )}
            <div className="pointer-events-none absolute inset-0" style={{ boxShadow: "inset 0 0 0 1px rgba(25,23,18,0.06)" }} />
          </div>
          <p className="kicker mt-2" style={{ color: "var(--color-faint)" }}>
            Generated on-device · Stable Diffusion 2.1
          </p>
        </Link>
      </div>
    </article>
  );
}
