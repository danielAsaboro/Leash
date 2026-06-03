import type { Block } from "../lib/layout.ts";
import type { ArticleCard as Card } from "../lib/queries.ts";
import { ArticleCard } from "./ArticleCard.tsx";

/**
 * Renders the day's composed mosaic (everything below the LEAD). Uses
 * `grid-auto-flow: row` (NOT dense) so blocks place in DOM order and new arrivals
 * append at the end — never reflowing what's already laid out. Column hairlines sit
 * in the gutters: every block that doesn't open a row carries a left rule.
 */
export function Mosaic({ blocks }: { blocks: Block<Card>[] }) {
  if (blocks.length === 0) return null;
  return (
    <section className="mosaic mt-8 pt-1">
      {blocks.map((b) => (
        <div key={b.article.id} className={`mosaic-cell mz-${b.span}`}>
          {!b.firstInRow && <span className="mosaic-rule" aria-hidden />}
          {/* `lead` never appears in the mosaic (it's the Hero); guard keeps the type honest. */}
          <ArticleCard article={b.article} size={b.size === "lead" ? "column" : b.size} />
        </div>
      ))}
    </section>
  );
}
