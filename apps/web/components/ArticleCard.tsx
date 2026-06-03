import Link from "next/link";
import type { ArticleCard as Card } from "../lib/queries.ts";
import { sectionKicker, isBulletin, bulletinKicker } from "../lib/ui.ts";

/** Block scales used by the front-page mosaic. `lead` is rendered separately (Hero). */
export type CardSize = "feature" | "column" | "brief";

/** Per-scale type sizing so the mosaic reads as a real broadsheet, not a uniform grid. */
const SCALE: Record<CardSize, { headline: string; dek: string; clamp: number; img: boolean }> = {
  feature: { headline: "clamp(1.7rem, 2.6vw, 2.2rem)", dek: "1.05rem", clamp: 3, img: true },
  column: { headline: "1.45rem", dek: "1rem", clamp: 3, img: true },
  brief: { headline: "1.12rem", dek: "0.95rem", clamp: 2, img: false },
};

/**
 * A mosaic story. Scales across `feature` / `column` / `brief`; carries
 * `data-article-id` so the live layer can flash it when it first arrives, and renders
 * the 📌 brick bulletin kicker for time-sensitive personal items.
 */
export function ArticleCard({
  article,
  size = "column",
  showImage = true,
}: {
  article: Card;
  size?: CardSize;
  showImage?: boolean;
}) {
  const href = `/${article.date}/${article.slug}`;
  const scale = SCALE[size];
  const withImage = showImage && scale.img && Boolean(article.heroImagePath);
  const bulletin = isBulletin(article);

  return (
    <article className="group flex flex-col" data-article-id={article.id}>
      {withImage && (
        <Link href={href} className="mb-3 block overflow-hidden" style={{ border: "1px solid var(--color-rule)" }}>
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
      <Link href={href}>
        <h3
          className="mt-1.5 transition-colors group-hover:opacity-75"
          style={{ fontFamily: "var(--font-display)", fontWeight: 600, lineHeight: 1.06, fontSize: scale.headline, letterSpacing: "-0.01em" }}
        >
          {article.headline}
        </h3>
      </Link>
      <p
        className="mt-2"
        style={{ color: "var(--color-ink-soft)", fontSize: scale.dek, lineHeight: 1.5, display: "-webkit-box", WebkitLineClamp: scale.clamp, WebkitBoxOrient: "vertical", overflow: "hidden" }}
      >
        {article.dek}
      </p>
      <span className="kicker mt-3" style={{ color: "var(--color-faint)" }}>
        {article._count.sources} sources · {article._count.claims} claims
      </span>
    </article>
  );
}
