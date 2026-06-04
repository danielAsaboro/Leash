import type { PaperPage as Page } from "../lib/layout.ts";
import type { ArticleCard } from "../lib/queries.ts";
import { sectionKicker } from "../lib/ui.ts";
import { LeadStory } from "./LeadStory.tsx";
import { StoryColumn } from "./StoryColumn.tsx";

/**
 * One broadsheet spread. A page-1 LEAD page lays a dominant `LeadStory` beside a rail
 * of secondary `StoryColumn`s; an interior page opens with a FEATURE over a balanced
 * row of columns. The page's seed (deterministic per day + page number) decides the
 * template variant — lead-left vs lead-right, 2- vs 3-column body, which secondary
 * carries a plate — so the rhythm always changes yet stays stable within a day.
 *
 * It is the horizontal scroll-snap child of the deck, so it carries `data-page-n`.
 */
export function PaperPage({ page }: { page: Page<ArticleCard> }) {
  const [head, ...rest] = page.stories;
  const isLeadPage = head!.role === "lead";

  // Seeded template flags — cheap bit-picks off the page seed.
  const leadRight = (page.seed & 1) === 1;
  const bodyCols = (page.seed >> 1) & 1 ? 3 : 2;
  const railPlate = (page.seed >> 2) & 1 ? 0 : 1; // which rail index carries a small plate (−1 = none on short rails)
  const featurePlate = ((page.seed >> 3) & 1) === 1;

  const headKicker = sectionKicker(head!.article.section, head!.article.origin);

  return (
    <section className="paper-page" data-page-n={page.n} aria-label={`Page ${page.n}`}>
      <div className="paper-sheet">
        <div className="page-folio">
          <span className="kicker" style={{ color: "var(--color-ink)", fontWeight: 600 }}>
            Page {page.n}
          </span>
          <span className="kicker" style={{ color: "var(--color-faint)" }}>
            {headKicker}
          </span>
        </div>
        <div className="page-rule-double" aria-hidden>
          <span />
          <span />
        </div>

        {isLeadPage ? (
          rest.length > 0 ? (
            <div className={`page-lead-grid${leadRight ? " is-lead-right" : ""}`}>
              <div className="lead-cell">
                <LeadStory article={head!.article} variant="lead" bodyCols={bodyCols} />
              </div>
              <div className="story-rail">
                {rest.map((s, i) => (
                  <StoryColumn key={s.article.id} article={s.article} plate={i === railPlate} />
                ))}
              </div>
            </div>
          ) : (
            <div className="lead-cell mt-6">
              <LeadStory article={head!.article} variant="lead" bodyCols={bodyCols} />
            </div>
          )
        ) : (
          <div className="page-feature">
            <div className="feature-cell">
              <LeadStory article={head!.article} variant="feature" bodyCols={2} plate={featurePlate} />
            </div>
            {rest.length > 0 && (
              <div className="story-row" style={{ ["--cols" as string]: String(rest.length) }}>
                {rest.map((s, i) => (
                  <StoryColumn key={s.article.id} article={s.article} plate={i === railPlate} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
