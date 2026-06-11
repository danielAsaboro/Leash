import Link from "next/link";
import type { Section } from "@mycelium/db";
import { getAdjacentEditions, getDaemonStatus, getEditionArticles, getInProduction, getMasthead, getSectionCounts } from "../../../lib/queries.ts";
import { sectionKicker } from "../../../lib/ui.ts";
import { composePaper } from "../../../lib/layout.ts";
import { Masthead } from "../../../components/Masthead.tsx";
import { CategoryNav } from "../../../components/CategoryNav.tsx";
import { EditionNav } from "../../../components/EditionNav.tsx";
import { PaperDeck, type PendingChip } from "../../../components/PaperDeck.tsx";
import { PaperPage } from "../../../components/PaperPage.tsx";
import { LiveRefresh } from "../../../components/LiveRefresh.tsx";

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

  // The compositor paginates the (possibly section-filtered) day into an append-only
  // run of broadsheet pages plus the page-bar chips. (See `composePaper`.)
  const { pages, chips } = composePaper(articles, date);

  // In-production stories trail the page-bar as ghosted chips — a peek at what's coming.
  const pendingChips: PendingChip[] = inProduction.map((a) => ({
    id: a.id,
    kicker: sectionKicker(a.section, a.origin),
    headline: a.headline,
    stage: a.stage,
  }));

  return (
    <div className="reader-shell">
      <LiveRefresh seconds={10} />

      {/* Pinned header zone — masthead, section tabs, and the dateline + edition pager. */}
      <div className="reader-header">
        <Masthead masthead={masthead} status={status} />
        <CategoryNav date={date} active={section ?? "ALL"} counts={counts} />
        <div className="mx-auto max-w-[1180px] px-5">
          <EditionNav
            date={date}
            prev={neighbors.prev}
            next={neighbors.next}
            published={articles.length}
            inProduction={inProduction.length}
            section={section}
          />
        </div>
      </div>

      {pages.length > 0 ? (
        <PaperDeck chips={chips} pending={pendingChips} date={date}>
          {pages.map((p) => (
            <PaperPage key={p.n} page={p} />
          ))}
        </PaperDeck>
      ) : (
        <div className="paper-empty">
          <p style={{ fontFamily: "var(--font-display)", fontSize: "1.8rem", fontWeight: 600 }}>The press is warming up.</p>
          <p className="kicker mt-3">
            {inProduction.length > 0 ? "Stories are in production — check back shortly." : "Run the newsroom to publish today's edition."}
          </p>
          <Link href="/services" className="kicker kicker-sage mt-4 inline-block">
            Open the newsroom controls →
          </Link>
        </div>
      )}
    </div>
  );
}
