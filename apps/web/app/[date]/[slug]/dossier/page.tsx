import Link from "next/link";
import { notFound } from "next/navigation";
import { getDossier, getMasthead } from "../../../../lib/queries.ts";
import { Masthead } from "../../../../components/Masthead.tsx";

export const dynamic = "force-dynamic";

interface PackSource {
  label: string;
  url?: string;
  kind: string;
  text: string;
}
interface ResearchPack {
  topic: string;
  sources: PackSource[];
}

export default async function DossierPage({ params }: { params: Promise<{ date: string; slug: string }> }) {
  const { date, slug } = await params;
  const [masthead, article] = await Promise.all([getMasthead(), getDossier(date, slug)]);
  if (!article || !article.dossier) notFound();

  let pack: ResearchPack | null = null;
  try {
    pack = JSON.parse(article.dossier.research) as ResearchPack;
  } catch {
    pack = null;
  }
  const nodeIds = (() => {
    try {
      return JSON.parse(article.dossier.graphNodeIds) as string[];
    } catch {
      return [];
    }
  })();

  return (
    <>
      <Masthead masthead={masthead} size="compact" />
      <main className="mx-auto max-w-[860px] px-5 pb-28">
        <div className="py-4">
          <Link href={`/${date}/${slug}`} className="kicker transition-opacity hover:opacity-60">
            ← Back to story
          </Link>
        </div>

        <header className="border-b-2 pb-5" style={{ borderColor: "var(--color-ink)" }}>
          <span className="kicker kicker-sage">Dossier</span>
          <h1 className="mt-2" style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: "clamp(1.8rem,4vw,2.8rem)", lineHeight: 1.05 }}>
            {article.headline}
          </h1>
          <p className="kicker mt-3">
            {pack?.sources.length ?? 0} sources · {nodeIds.length} graph nodes embedded
            {article.dossier.tokens != null ? ` · ${article.dossier.tokens} chunks` : ""}
          </p>
          {pack?.topic && (
            <p className="mt-3 italic" style={{ color: "var(--color-muted)" }}>
              Research focus: {pack.topic}
            </p>
          )}
        </header>

        <p className="mt-6" style={{ color: "var(--color-ink-soft)" }}>
          This is the raw research pack the newsroom assembled and embedded into this story&rsquo;s private
          retrieval workspace. Every <span className="cite" style={{ verticalAlign: "baseline" }}>[Source N]</span>{" "}
          citation in the article is grounded in one of the passages below.
        </p>

        <section className="mt-8 space-y-6">
          {pack?.sources.map((s, i) => (
            <article key={i} className="border p-5" style={{ borderColor: "var(--color-rule)", background: "var(--color-paper)" }}>
              <div className="flex items-center justify-between gap-3">
                <span className="kicker">
                  Source {i + 1} · {s.kind}
                </span>
                {s.url && (
                  <a href={s.url} target="_blank" rel="noreferrer" className="kicker kicker-sage hover:opacity-70">
                    open ↗
                  </a>
                )}
              </div>
              <h2 className="mt-1" style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: "1.2rem" }}>
                {s.label}
              </h2>
              <p className="mt-2" style={{ fontFamily: "var(--font-body)", lineHeight: 1.55, color: "var(--color-ink-soft)" }}>
                {s.text}
              </p>
            </article>
          ))}
        </section>
      </main>
    </>
  );
}
