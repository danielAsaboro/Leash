import Link from "next/link";
import { notFound } from "next/navigation";
import { getArticle, getMasthead } from "../../../lib/queries.ts";
import { formatLong } from "../../../lib/date.ts";
import { sectionKicker, stageLabel } from "../../../lib/ui.ts";
import { Masthead } from "../../../components/Masthead.tsx";
import { Markdown } from "../../../lib/markdown.tsx";
import { SourcesList } from "../../../components/SourcesList.tsx";
import { ClaimsList } from "../../../components/ClaimsList.tsx";
import { LiveRefresh } from "../../../components/LiveRefresh.tsx";
import { ArticleAudio } from "../../../components/ArticleAudio.tsx";

export const dynamic = "force-dynamic";

export default async function ArticlePage({ params }: { params: Promise<{ date: string; slug: string }> }) {
  const { date, slug } = await params;
  const [masthead, article] = await Promise.all([getMasthead(), getArticle(date, slug)]);
  if (!article) notFound();

  const published = article.stage === "PUBLISHED";

  return (
    <>
      {!published && <LiveRefresh seconds={6} />}
      <Masthead masthead={masthead} size="compact" />

      <main className="mx-auto max-w-[1180px] px-5 pb-28">
        <div className="py-4">
          <Link href={`/${date}`} className="kicker transition-opacity hover:opacity-60">
            ← Back to articles
          </Link>
        </div>

        {/* Headline block */}
        <header className="mx-auto max-w-[860px] text-center">
          <span className="kicker kicker-sage">{sectionKicker(article.section, article.origin)}</span>
          <h1
            className="mx-auto mt-3"
            style={{ fontFamily: "var(--font-display)", fontWeight: 900, lineHeight: 1.0, letterSpacing: "-0.015em", fontSize: "clamp(2.2rem,5vw,3.8rem)" }}
          >
            {article.headline}
          </h1>
          <p className="mx-auto mt-5 max-w-[640px] italic" style={{ fontFamily: "var(--font-body)", fontSize: "1.3rem", lineHeight: 1.45, color: "var(--color-ink-soft)" }}>
            {article.dek}
          </p>
          <div className="mt-5 flex items-center justify-center gap-3">
            <span className="kicker">{sectionKicker(article.section, article.origin)}</span>
            <span style={{ color: "var(--color-rule-strong)" }}>·</span>
            <span className="kicker">{formatLong(article.date)}</span>
            <span style={{ color: "var(--color-rule-strong)" }}>·</span>
            <span className="kicker inline-flex items-center gap-1.5" style={{ color: published ? "var(--color-sage-deep)" : "var(--color-muted)" }}>
              <span className="inline-block rounded-full" style={{ width: 7, height: 7, background: published ? "var(--color-sage)" : "var(--color-faint)" }} />
              {stageLabel(article.stage)}
            </span>
          </div>
          {article.audioPath && <ArticleAudio src={article.audioPath} />}
        </header>

        {/* Hero plate */}
        {article.heroImagePath && (
          <figure className="mx-auto mt-9 max-w-[980px]">
            <div style={{ border: "1px solid var(--color-rule-strong)", boxShadow: "0 22px 50px -30px rgba(25,23,18,0.5)" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={article.heroImagePath} alt="" className="block aspect-[3/2] w-full object-cover" style={{ filter: "saturate(0.92) contrast(1.02)" }} />
            </div>
            {article.heroPrompt && (
              <figcaption className="kicker mt-2 text-center" style={{ color: "var(--color-faint)" }}>
                On-device illustration · “{article.heroPrompt.slice(0, 90)}…”
              </figcaption>
            )}
          </figure>
        )}

        {/* Body + rail */}
        <div className="mt-12 grid grid-cols-1 gap-12 lg:grid-cols-[1fr_300px]">
          <div className="mx-auto w-full max-w-[680px]">
            {article.body ? (
              <Markdown body={article.body} lead />
            ) : (
              <p className="kicker">This story is still being written…</p>
            )}
          </div>

          <aside className="lg:sticky lg:top-8 lg:self-start">
            {article.sources.length > 0 && <SourcesList sources={article.sources} />}
            <ClaimsList claims={article.claims} />
            {article.dossier && (
              <div className="mt-9 border-t pt-4" style={{ borderColor: "var(--color-rule)" }}>
                <Link href={`/${date}/${slug}/dossier`} className="kicker kicker-sage transition-opacity hover:opacity-60">
                  Open dossier →
                </Link>
                <p className="kicker mt-1" style={{ color: "var(--color-faint)" }}>
                  The research behind this story
                </p>
              </div>
            )}
          </aside>
        </div>
      </main>
    </>
  );
}
