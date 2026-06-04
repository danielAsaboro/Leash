import Link from "next/link";
import type { ArticleCard } from "../lib/queries.ts";
import { sectionKicker, isBulletin, bulletinKicker } from "../lib/ui.ts";
import { Markdown, excerpt } from "../lib/markdown.tsx";

/** Beyond this word count a secondary column clamps to a teaser + "Continue Reading". */
const CLAMP_WORDS = 150;

/**
 * A secondary story rendered as a proper newspaper column: kicker (or the 📌 brick
 * bulletin kicker for time-sensitive personal items), headline, an optional small
 * plate, then the **real body** — set justified via `Markdown`. Short bodies (the
 * common case for these editions) print in full; a long one clamps to an excerpt so
 * a single column never runs away. `data-article-id` is kept for the live ring.
 */
export function StoryColumn({ article, plate = false }: { article: ArticleCard; plate?: boolean }) {
  const href = `/${article.date}/${article.slug}`;
  const bulletin = isBulletin(article);
  const showPlate = plate && Boolean(article.heroImagePath);
  const body = article.body?.trim() ?? "";
  const long = body ? body.split(/\s+/).length > CLAMP_WORDS : false;

  return (
    <article className="story-col" data-article-id={article.id}>
      {showPlate && (
        <Link href={href} className="group mb-3 block overflow-hidden" style={{ border: "1px solid var(--color-rule)" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={article.heroImagePath!}
            alt=""
            className="block aspect-[3/2] w-full object-cover transition-transform duration-700 group-hover:scale-[1.04]"
            style={{ filter: "saturate(0.9) contrast(1.02)" }}
          />
        </Link>
      )}

      {bulletin ? (
        <span className="kicker inline-flex items-center gap-1.5" style={{ color: "var(--color-brick)", fontWeight: 600 }}>
          <span aria-hidden>📌</span>
          {bulletinKicker(article)}
        </span>
      ) : (
        <span className="kicker kicker-sage">{sectionKicker(article.section, article.origin)}</span>
      )}

      <Link href={href} className="group block">
        <h3
          className="mt-1.5 transition-colors group-hover:opacity-75"
          style={{ fontFamily: "var(--font-display)", fontWeight: 700, lineHeight: 1.05, fontSize: "1.5rem", letterSpacing: "-0.01em" }}
        >
          {article.headline}
        </h3>
      </Link>

      <div className="story-col-rule" aria-hidden />

      {!body ? (
        <p className="prose-broadsheet story-col-body">{article.dek}</p>
      ) : long ? (
        <div className="story-col-body">
          <p className="prose-broadsheet">{excerpt(body, 90) || article.dek}</p>
          <Link href={href} className="kicker" style={{ color: "var(--color-sage-deep)" }}>
            Continue Reading →
          </Link>
        </div>
      ) : (
        <div className="story-col-body">
          <Markdown body={body} />
        </div>
      )}

      <span className="kicker mt-3 block" style={{ color: "var(--color-faint)" }}>
        {article._count.sources} sources · {article._count.claims} claims
      </span>
    </article>
  );
}
