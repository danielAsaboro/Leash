import Link from "next/link";
import type { Section } from "@mycelium/db";
import { getAdjacentEditions, getDaemonStatus, getEditionArticles, getInProduction, getMasthead, getSectionCounts } from "../../lib/queries.ts";
import { sectionKicker, isBulletin, bulletinKicker } from "../../lib/ui.ts";
import { composeFrontPage } from "../../lib/layout.ts";
import { Masthead } from "../../components/Masthead.tsx";
import { CategoryNav } from "../../components/CategoryNav.tsx";
import { EditionNav } from "../../components/EditionNav.tsx";
import { Hero } from "../../components/Hero.tsx";
import { Mosaic } from "../../components/Mosaic.tsx";
import { LiveFront, type LiveItem } from "../../components/LiveFront.tsx";
import { StageTracker } from "../../components/StageTracker.tsx";
import { LiveRefresh } from "../../components/LiveRefresh.tsx";

export const dynamic = "force-dynamic";

const SECTIONS = new Set(["AI", "COMPUTE", "SOLANA", "BRIEF"]);

export default async function EditionPage({
  params,
  searchParams,
}: {
  params: Promise<{ date: string }>;
  searchParams: Promise<{ section?: string }>;
}) {
  const { date } = await params;
  const { section: rawSection } = await searchParams;
  const section = rawSection && SECTIONS.has(rawSection) ? (rawSection as Section) : undefined;

  const [masthead, status, articles, inProduction, counts, neighbors] = await Promise.all([
    getMasthead(),
    getDaemonStatus(),
    getEditionArticles(date, section),
    getInProduction(date),
    getSectionCounts(date),
    getAdjacentEditions(date),
  ]);

  // The compositor lays the (possibly section-filtered) set into an append-only mosaic.
  const { lead, blocks } = composeFrontPage(articles, date);

  // The live band tracks the *whole* day's published set (independent of the section
  // filter) so "what's new" stays consistent as you move between tabs.
  const liveSource = section ? await getEditionArticles(date) : articles;
  const liveItems: LiveItem[] = liveSource.map((a) => {
    const bulletin = isBulletin(a);
    return {
      id: a.id,
      date: a.date,
      slug: a.slug,
      section: a.section,
      headline: a.headline,
      bulletin,
      kicker: bulletin ? bulletinKicker(a) : a.origin === "PERSONAL" ? "Private Brief" : a.section,
      publishedAt: a.publishedAt ? a.publishedAt.getTime() : 0,
    };
  });

  return (
    <>
      <LiveRefresh seconds={10} />
      <Masthead masthead={masthead} status={status} />
      <CategoryNav date={date} active={section ?? "ALL"} counts={counts} />
      <LiveFront items={liveItems} />

      <main className="mx-auto max-w-[1180px] px-5 pb-24">
        {/* Dateline + edition pagination */}
        <EditionNav
          date={date}
          prev={neighbors.prev}
          next={neighbors.next}
          published={articles.length}
          inProduction={inProduction.length}
          section={section}
        />

        {lead ? (
          <>
            <Hero article={lead.article} />

            {/* In-production strip — moved below the lead. */}
            {inProduction.length > 0 && (
              <section className="mt-2 border-y py-3" style={{ borderColor: "var(--color-rule)", background: "color-mix(in srgb, var(--color-paper) 60%, transparent)" }}>
                <div className="mb-2 flex items-center gap-3 px-1">
                  <span className="kicker kicker-sage">In Production</span>
                  <span className="h-px flex-1" style={{ background: "var(--color-rule)" }} />
                </div>
                <ul className="grid grid-cols-1 gap-x-8 gap-y-3 px-1 sm:grid-cols-2 lg:grid-cols-3">
                  {inProduction.map((a) => (
                    <li key={a.id} className="flex flex-col gap-1">
                      <span className="kicker" style={{ color: "var(--color-faint)" }}>
                        {sectionKicker(a.section, a.origin)}
                      </span>
                      <span style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: "1.05rem", lineHeight: 1.1 }}>
                        {a.headline}
                      </span>
                      <div className="mt-1">
                        <StageTracker stage={a.stage} />
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* The append-only mosaic. */}
            {blocks.length > 0 && (
              <>
                <div className="mt-7 border-t-2" style={{ borderColor: "var(--color-ink)" }} />
                <div className="mt-[3px] border-t" style={{ borderColor: "var(--color-ink)" }} />
                <Mosaic blocks={blocks} />
              </>
            )}
          </>
        ) : (
          <div className="py-24 text-center">
            <p style={{ fontFamily: "var(--font-display)", fontSize: "1.8rem", fontWeight: 600 }}>The press is warming up.</p>
            <p className="kicker mt-3">
              {inProduction.length > 0 ? "Stories are in production — check back shortly." : "Run the newsroom to publish today's edition."}
            </p>
            <Link href="/mission-control" className="kicker kicker-sage mt-4 inline-block">
              Open Mission Control →
            </Link>
          </div>
        )}

        {/* Footer pagination — jump editions without scrolling back up. */}
        {(neighbors.prev || neighbors.next) && (
          <>
            <div className="mt-12 border-t" style={{ borderColor: "var(--color-rule)" }} />
            <EditionNav date={date} prev={neighbors.prev} next={neighbors.next} variant="footer" />
          </>
        )}
      </main>
    </>
  );
}
