import Link from "next/link";
import type { ArticleCard } from "../lib/queries.ts";
import { sectionKicker } from "../lib/ui.ts";
import { Markdown } from "../lib/markdown.tsx";

/**
 * The dominant story on a page: the page-1 LEAD or an interior page's FEATURE. Kicker
 * + rule, an oversized Fraunces headline, an italic dek, the on-device hero plate, then
 * the full body set as justified, drop-capped, column-ruled newsprint via `Markdown`.
 *
 * `bodyCols` (seeded by the page) picks 2- vs 3-column flow; `variant` scales the
 * headline (a feature reads a notch smaller than the lead). `plate` lets a page drop
 * the image to vary the rhythm. `data-article-id` is kept so the live layer can ring
 * it when it first arrives.
 */
export function LeadStory({
  article,
  variant = "lead",
  bodyCols = 3,
  plate = true,
}: {
  article: ArticleCard;
  variant?: "lead" | "feature";
  bodyCols?: number;
  plate?: boolean;
}) {
  const href = `/feed/${article.date}/${article.slug}`;
  const isLead = variant === "lead";
  const showPlate = plate && Boolean(article.heroImagePath);
  const hasBody = Boolean(article.body && article.body.trim());

  return (
    <article className="lead-story" data-article-id={article.id}>
      <div className="flex items-center gap-3">
        <span className="kicker kicker-sage">{sectionKicker(article.section, article.origin)}</span>
        <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
      </div>

      <Link href={href} className="group block">
        <h1
          className="mt-3 transition-colors group-hover:opacity-80"
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 900,
            lineHeight: 0.97,
            letterSpacing: "-0.015em",
            fontSize: isLead ? "clamp(2.3rem, 4.6vw, 4rem)" : "clamp(1.8rem, 3vw, 2.6rem)",
          }}
        >
          {article.headline}
        </h1>
      </Link>

      <p
        className="mt-3 italic"
        style={{
          fontFamily: "var(--font-body)",
          fontSize: isLead ? "1.28rem" : "1.12rem",
          lineHeight: 1.42,
          color: "var(--color-ink-soft)",
        }}
      >
        {article.dek}
      </p>

      {showPlate && (
        <Link href={href} className="group mt-4 block overflow-hidden lead-plate">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={article.heroImagePath!}
            alt=""
            className="block aspect-[3/2] w-full object-cover transition-transform duration-700 group-hover:scale-[1.03]"
            style={{ filter: "saturate(0.92) contrast(1.02)" }}
          />
          <span className="pointer-events-none absolute inset-0" style={{ boxShadow: "inset 0 0 0 1px rgba(25,23,18,0.06)" }} />
        </Link>
      )}

      {hasBody ? (
        <div className="lead-body mt-5" style={{ ["--lead-cols" as string]: String(bodyCols) }}>
          <Markdown body={article.body!} lead />
        </div>
      ) : (
        <p className="prose-broadsheet mt-5">{article.dek}</p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-4">
        <Link href={href} className="kicker" style={{ color: "var(--color-sage-deep)" }}>
          Continue Reading →
        </Link>
        <span className="kicker" style={{ color: "var(--color-faint)" }}>
          {article._count.sources} sources · {article._count.claims} claims
        </span>
      </div>
    </article>
  );
}
