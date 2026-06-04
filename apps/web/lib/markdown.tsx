/**
 * A tiny, dependency-free markdown renderer for article bodies.
 *
 * The drafter emits a constrained subset — paragraphs, `- ` bullets, `**bold**`,
 * `*italic*`, and `[Source N]` citations — so we don't need a full markdown engine.
 * The payoff of doing it ourselves: `[Source N]` becomes an anchored citation chip
 * that scrolls to the matching SOURCES row, keeping body ↔ sidebar in lockstep.
 */
import type { ReactNode } from "react";

/**
 * A plain-text excerpt of a markdown body — strips the constrained token set
 * (`**bold**`, `*italic*`, `[Source N]`, `- ` bullets) down to prose and returns the
 * first paragraph, capped at `words`. Client-safe (no `@mycelium/db` import) so the
 * page can clamp an over-long secondary story to a teaser. Returns "" for an empty
 * body, so callers can fall back to the dek: `excerpt(body) || dek`.
 */
export function excerpt(body: string, words = 48): string {
  const firstPara =
    body
      .replace(/\r/g, "")
      .split(/\n\s*\n/)
      .map((s) => s.trim())
      .find(Boolean) ?? "";
  const plain = firstPara
    .replace(/\[Source\s*\d+\]/gi, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return "";
  const parts = plain.split(" ");
  return parts.length <= words ? plain : parts.slice(0, words).join(" ") + "…";
}

/** Parse inline spans: **bold**, *italic*, and [Source N] → citation chips. */
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Split on the three inline tokens, keeping the delimiters.
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|\[Source\s*\d+\])/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;
    if (tok.startsWith("**")) {
      out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("*")) {
      out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    } else {
      const n = tok.match(/\d+/)?.[0] ?? "";
      out.push(
        <a key={key} href={`#source-${n}`} className="cite" aria-label={`Source ${n}`}>
          {n}
        </a>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Render a markdown body to broadsheet prose. `lead` adds the drop cap. */
export function Markdown({ body, lead = false }: { body: string; lead?: boolean }) {
  const blocks: ReactNode[] = [];
  // Split into blocks on blank lines; group consecutive `- ` lines into one list.
  const lines = body.replace(/\r/g, "").split("\n");
  let para: string[] = [];
  let bullets: string[] = [];
  let b = 0;

  const flushPara = () => {
    if (para.length) {
      const text = para.join(" ").trim();
      if (text) blocks.push(<p key={`p-${b++}`}>{inline(text, `p${b}`)}</p>);
      para = [];
    }
  };
  const flushList = () => {
    if (bullets.length) {
      blocks.push(
        <ul key={`u-${b++}`}>
          {bullets.map((li, i) => (
            <li key={i}>{inline(li, `li${b}-${i}`)}</li>
          ))}
        </ul>,
      );
      bullets = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushPara();
      flushList();
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      flushPara();
      bullets.push(bullet[1] ?? "");
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();

  return <div className={`prose-broadsheet${lead ? " lead" : ""}`}>{blocks}</div>;
}
