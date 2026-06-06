"use client";
import Link from "next/link";
import { Tool, ToolHeader, ToolContent, ToolInput, ToolOutput } from "@/components/ai-elements/tool";

/**
 * Generative UI for Leash's tools — renders each tool result as a bespoke broadsheet
 * component instead of a raw JSON dump (per the AI SDK "connect tool output → React
 * component" pattern). Keyed on the typed `tool-${name}` part + its `state`:
 *   · understory_today / understory_search → clickable paper cards
 *   · search_graph                         → private-note snippet cards
 *   · now                                  → a date/time chip
 * Unknown tools (e.g. future MCP tools) fall back to the generic AI Elements <Tool>.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Part = any;
type Source = { kind: "graph" | "paper"; title: string; snippet: string; url?: string };

const toolName = (p: Part): string => (p.type === "dynamic-tool" ? String(p.toolName) : String(p.type).slice("tool-".length));

const LOADING_LABEL: Record<string, string> = {
  search_graph: "Searching your notes…",
  understory_today: "Reading today's paper…",
  understory_search: "Searching the paper…",
  now: "Checking the time…",
  generate_image: "Painting your image (on-device)…",
};

/** Approval handle (mirrors LeashChat's) — present only when the card is actionable. */
interface ApprovalHandle {
  respond: (args: { id: string; approved: boolean; reason?: string }) => void;
}

export function ToolView({ part, approval }: { part: Part; approval?: ApprovalHandle }) {
  const name = toolName(part);
  const state = part.state as string;

  if (state === "input-streaming" || state === "input-available") {
    return <div className="tool-loading">{LOADING_LABEL[name] ?? `Running ${name}…`}</div>;
  }
  if (state === "output-error") {
    return <div className="tool-card tool-error-card">⚠ {name}: {String(part.errorText ?? "failed")}</div>;
  }
  // HITL "Ask first": the run pauses here until the user approves or denies.
  if (state === "approval-requested") return <ApprovalCard name={name} part={part} approval={approval} />;
  if (state === "approval-responded") {
    return (
      <div className="tool-card">
        <span className="tool-card-kicker kicker">
          {part.approval?.approved ? "✓ Approved" : "✕ Denied"} · {name} {part.approval?.approved ? "— running…" : ""}
        </span>
      </div>
    );
  }
  if (state === "output-denied") {
    return (
      <div className="tool-card">
        <span className="tool-card-kicker kicker" style={{ color: "var(--color-brick)" }}>
          ✕ {name} — denied by you, not run
        </span>
      </div>
    );
  }
  if (state !== "output-available") return null;

  const output = part.output ?? {};
  if (name === "understory_today" || name === "understory_search") return <PaperCard output={output} />;
  if (name === "search_graph") return <NotesCard output={output} />;
  if (name === "now") return <NowChip output={output} />;
  if (name === "generate_image") return <ImageCard output={output} />;
  return <GenericTool part={part} />;
}

function PaperCard({ output }: { output: { sources?: Source[] } }) {
  const articles = (output.sources ?? []).filter((s) => s.kind === "paper");
  if (articles.length === 0) return <div className="tool-card"><span className="tool-card-kicker kicker">📰 Nothing in the paper</span></div>;
  return (
    <div className="tool-card">
      <span className="tool-card-kicker kicker kicker-sage">📰 The Understory</span>
      <div className="tool-articles">
        {articles.map((a, i) => (
          <Link key={i} href={a.url ?? "#"} className="tool-article">
            <span className="tool-article-title">{a.title}</span>
            {a.snippet && <span className="tool-article-dek">{a.snippet}</span>}
          </Link>
        ))}
      </div>
    </div>
  );
}

function NotesCard({ output }: { output: { sources?: Source[] } }) {
  const notes = (output.sources ?? []).filter((s) => s.kind === "graph");
  if (notes.length === 0) return <div className="tool-card"><span className="tool-card-kicker kicker">🔎 No matching notes</span></div>;
  return (
    <div className="tool-card">
      <span className="tool-card-kicker kicker kicker-sage">🔎 From your notes</span>
      <div className="tool-notes">
        {notes.map((n, i) => (
          <div key={i} className="tool-note">
            <span className="tool-note-src">{n.title}</span>
            <span className="tool-note-snip">{n.snippet}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ImageCard({ output }: { output: { url?: string; prompt?: string; error?: string } }) {
  if (output.error) return <div className="tool-card tool-error-card">⚠ {output.error}</div>;
  if (!output.url) return null;
  return (
    <div className="tool-card">
      <span className="tool-card-kicker kicker kicker-sage">🎨 Generated · on-device</span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={output.url} alt={output.prompt ?? "generated image"} className="tool-image" />
    </div>
  );
}

function NowChip({ output }: { output: { text?: string } }) {
  const when = String(output.text ?? "").replace(/^Current local date\/time:\s*/, "");
  return (
    <div className="now-chip">
      <span aria-hidden>🕑</span> {when || "now"}
    </div>
  );
}

/**
 * The approval card: tool name + pretty-printed input + Approve / Deny. Only actionable
 * on the last assistant message of an idle chat (the `approval` handle is withheld
 * otherwise — e.g. mid-stream or in history after a reload).
 */
function ApprovalCard({ name, part, approval }: { name: string; part: Part; approval?: ApprovalHandle }) {
  const input = part.input ?? {};
  const pretty = JSON.stringify(input, null, 2);
  return (
    <div className="tool-card tool-approval-card">
      <span className="tool-card-kicker kicker kicker-sage">⏸ Approval needed · {name}</span>
      <pre className="tool-approval-input">{pretty}</pre>
      {approval && part.approval?.id ? (
        <div className="tool-approval-actions">
          <button type="button" className="tool-approve" onClick={() => approval.respond({ id: part.approval.id, approved: true })}>
            ✓ Approve &amp; run
          </button>
          <button type="button" className="tool-deny" onClick={() => approval.respond({ id: part.approval.id, approved: false, reason: "denied by user" })}>
            ✕ Deny
          </button>
        </div>
      ) : (
        <span className="kicker" style={{ color: "var(--color-faint)" }}>
          awaiting a decision
        </span>
      )}
    </div>
  );
}

function GenericTool({ part }: { part: Part }) {
  return (
    <Tool defaultOpen={false}>
      {part.type === "dynamic-tool" ? <ToolHeader type="dynamic-tool" state={part.state} toolName={part.toolName} /> : <ToolHeader type={part.type} state={part.state} />}
      <ToolContent>
        <ToolInput input={part.input} />
        <ToolOutput output={part.output} errorText={part.errorText} />
      </ToolContent>
    </Tool>
  );
}
