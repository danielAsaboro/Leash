"use client";
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  AppleIcon,
  BookOpenTextIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  ClockIcon,
  FolderIcon,
  ImageIcon,
  ListTodoIcon,
  SearchIcon,
  SquarePenIcon,
  StickyNoteIcon,
  StickyNotePlusIcon,
  Trash2Icon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";
import { Tool, ToolHeader, ToolContent, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { Task, TaskTrigger, TaskContent, TaskItem } from "@/components/ai-elements/task";
import { Confirmation, ConfirmationTitle, ConfirmationRequest, ConfirmationActions, ConfirmationAction } from "@/components/ai-elements/confirmation";
import type { TaskRow } from "@/lib/leash/task-tools";
import { toast } from "./Toast.tsx";

/**
 * Generative UI for Leash's tools — renders each tool result as a bespoke broadsheet
 * component instead of a raw JSON dump (per the AI SDK "connect tool output → React
 * component" pattern). Keyed on the typed `tool-${name}` part + its `state`:
 *   · understory_today / understory_search → clickable paper cards
 *   · search_graph                         → private-context snippet cards
 *   · now                                  → a date/time chip
 * Unknown tools (e.g. future MCP tools) fall back to the generic AI Elements <Tool>.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Part = any;
type Source = { kind: "graph" | "paper"; title: string; snippet: string; url?: string };
type AppleNoteRow = {
  id?: string;
  openUrl?: string;
  deepLinkIdentifier?: string;
  title?: string;
  content?: string;
  folder?: string;
  account?: string;
  created?: string;
  modified?: string;
  tags?: string[];
};

export const toolName = (p: Part): string => (p.type === "dynamic-tool" ? String(p.toolName) : String(p.type).slice("tool-".length));
const isTool = (p: Part): boolean => typeof p?.type === "string" && (p.type.startsWith("tool-") || p.type === "dynamic-tool");
const APPLE_NOTES_TOOLS = new Set([
  "doctor",
  "search-notes",
  "list-notes",
  "get-note-content",
  "get-note-details",
  "get-note-by-id",
  "create-note",
  "update-note",
  "delete-note",
  "move-note",
  "list-folders",
  "list-accounts",
]);

const LOADING_LABEL: Record<string, string> = {
  search_graph: "Searching private context…",
  understory_today: "Reading today's paper…",
  understory_search: "Searching the paper…",
  now: "Checking the time…",
  generate_image: "Painting your image (on-device)…",
  list_tasks: "Reading your TODO list…",
  create_task: "Adding a TODO…",
  update_task: "Updating a TODO…",
  doctor: "Checking Apple Notes access…",
  "search-notes": "Searching Apple Notes…",
  "list-notes": "Listing Apple Notes…",
  "get-note-content": "Reading Apple Note…",
  "get-note-details": "Reading Apple Note details…",
  "get-note-by-id": "Reading Apple Note…",
  "create-note": "Creating Apple Note…",
  "update-note": "Updating Apple Note…",
  "delete-note": "Deleting Apple Note…",
  "move-note": "Moving Apple Note…",
  "list-folders": "Reading Apple Notes folders…",
  "list-accounts": "Reading Apple Notes accounts…",
};

/** Label once a tool has produced output — past-tense, for the collapsed timeline node. */
const DONE_LABEL: Record<string, string> = {
  search_graph: "Searched private context",
  understory_today: "Read today's paper",
  understory_search: "Searched the paper",
  now: "Checked the time",
  generate_image: "Generated an image",
  list_tasks: "Listed your TODOs",
  create_task: "Created a TODO",
  update_task: "Updated a TODO",
  doctor: "Checked Apple Notes access",
  "search-notes": "Searched Apple Notes",
  "list-notes": "Listed Apple Notes",
  "get-note-content": "Read Apple Note",
  "get-note-details": "Read Apple Note details",
  "get-note-by-id": "Read Apple Note",
  "create-note": "Created Apple Note",
  "update-note": "Updated Apple Note",
  "delete-note": "Deleted Apple Note",
  "move-note": "Moved Apple Note",
  "list-folders": "Listed Apple Notes folders",
  "list-accounts": "Listed Apple Notes accounts",
};

const TOOL_ICON: Record<string, LucideIcon> = {
  search_graph: SearchIcon,
  understory_today: SearchIcon,
  understory_search: SearchIcon,
  now: ClockIcon,
  generate_image: ImageIcon,
  list_tasks: ListTodoIcon,
  create_task: ListTodoIcon,
  update_task: ListTodoIcon,
  doctor: AppleIcon,
  "search-notes": SearchIcon,
  "list-notes": StickyNoteIcon,
  "get-note-content": BookOpenTextIcon,
  "get-note-details": BookOpenTextIcon,
  "get-note-by-id": BookOpenTextIcon,
  "create-note": StickyNotePlusIcon,
  "update-note": SquarePenIcon,
  "delete-note": Trash2Icon,
  "move-note": FolderIcon,
  "list-folders": FolderIcon,
  "list-accounts": AppleIcon,
};

/** Icon + label + status for a tool's timeline node (the ChainOfThought step header). */
export interface ToolNodeMeta {
  icon: LucideIcon;
  label: string;
  status: "active" | "complete";
  error: boolean;
}

export function toolMeta(part: Part): ToolNodeMeta {
  const name = toolName(part);
  const icon = TOOL_ICON[name] ?? WrenchIcon;
  switch (part.state as string) {
    case "input-streaming":
    case "input-available":
      return { icon, label: LOADING_LABEL[name] ?? `Running ${name}…`, status: "active", error: false };
    case "approval-requested":
      return { icon, label: `Approval needed · ${name}`, status: "active", error: false };
    case "approval-responded":
      return { icon, label: part.approval?.approved ? `Approved · ${name} — running…` : `Denied · ${name}`, status: "complete", error: false };
    case "output-denied":
      return { icon, label: `${name} — denied, not run`, status: "complete", error: true };
    case "output-error":
      return { icon, label: `${name} failed`, status: "complete", error: true };
    case "output-available":
      return { icon, label: DONE_LABEL[name] ?? `Ran ${name}`, status: "complete", error: false };
    default:
      return { icon, label: name, status: "complete", error: false };
  }
}

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
  if (APPLE_NOTES_TOOLS.has(name)) return <AppleNotesCard name={name} input={part.input ?? {}} output={output} />;
  if (name === "now") return <NowChip output={output} />;
  if (name === "generate_image") return <ImageCard output={output} />;
  if (name.startsWith("agent__")) return <AgentCard part={part} />;
  return <GenericTool part={part} />;
}

/**
 * The inner card body for a tool, to nest as the `children` of a ChainOfThought step
 * (the step header carries the icon/label/status via `toolMeta`). Returns null for the
 * pure-loading / responded / denied states — the node header already conveys those.
 */
export function ToolCard({ part, approval }: { part: Part; approval?: ApprovalHandle }) {
  const name = toolName(part);
  const state = part.state as string;
  if (state === "input-streaming" || state === "input-available") return null;
  if (state === "output-error") return <div className="tool-card tool-error-card">⚠ {String(part.errorText ?? "failed")}</div>;
  if (state === "approval-requested") return <ApprovalCard name={name} part={part} approval={approval} />;
  if (state === "approval-responded" || state === "output-denied") return null;
  if (state !== "output-available") return null;
  const output = part.output ?? {};
  if (name === "list_tasks" || name === "create_task" || name === "update_task") return <TaskCard output={output} />;
  if (name === "understory_today" || name === "understory_search") return <PaperCard output={output} />;
  if (name === "search_graph") return <NotesCard output={output} />;
  if (APPLE_NOTES_TOOLS.has(name)) return <AppleNotesCard name={name} input={part.input ?? {}} output={output} />;
  if (name === "now") return <NowChip output={output} />;
  if (name === "generate_image") return <ImageCard output={output} />;
  if (name.startsWith("agent__")) return <AgentCard part={part} />;
  return <GenericTool part={part} />;
}

/**
 * A sub-agent's run, rendered from the streamed UIMessage transcript the agent tool yields (the AI SDK
 * subagent UI pattern: `part.output.parts.map(...)`). Shows the subagent's text plus the nested tools it
 * called — so the /chat page reveals the delegated work, while the MAIN model only saw the summary
 * (`toModelOutput`). Updates live as preliminary tool results stream in.
 */
function AgentCard({ part }: { part: Part }): React.ReactNode {
  const display = toolName(part).replace(/^agent__/, "").replace(/__/g, ":");
  const nested = (part.output as { parts?: Array<{ type?: string; text?: string; toolName?: string }> } | undefined)?.parts ?? [];
  const stripThink = (t: string): string => t.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  return (
    <div className="tool-card">
      <span className="tool-card-kicker kicker kicker-sage">⛓ Sub-agent · {display}</span>
      {nested.map((p, i) => {
        const t = typeof p.type === "string" ? p.type : "";
        if (t === "text" && typeof p.text === "string") {
          const clean = stripThink(p.text);
          return clean ? <span key={i} className="tool-note-snip">{clean}</span> : null;
        }
        if (t.startsWith("tool-") || t === "dynamic-tool") {
          const tn = t === "dynamic-tool" ? String(p.toolName ?? "tool") : t.slice("tool-".length);
          return <div key={i} className="agent-substep" style={{ opacity: 0.7, fontSize: "0.85em" }}>↳ called <code>{tn}</code></div>;
        }
        return null;
      })}
    </div>
  );
}

const TASK_GLYPH: Record<string, string> = { open: "○", in_progress: "◐", done: "✓", dropped: "✕" };

/** The official AI Elements `Task` component, fed the structured rows the task tools now
 *  return alongside `text`. Falls back to the `text` summary for older (pre-structured)
 *  messages or single-task create/update results without rows. */
function TaskCard({ output }: { output: { tasks?: TaskRow[]; task?: TaskRow; text?: string } }) {
  const rows = output.tasks ?? (output.task ? [output.task] : []);
  if (rows.length === 0) {
    return (
      <div className="tool-card">
        <span className="tool-card-kicker kicker kicker-sage">✓ TODOs</span>
        {output.text ? <span className="tool-note-snip">{output.text}</span> : null}
      </div>
    );
  }
  const title = rows.length === 1 ? rows[0]!.title : `${rows.length} TODOs`;
  return (
    <Task defaultOpen>
      <TaskTrigger title={title}>
        <div className="group flex w-full cursor-pointer items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground">
          <ListTodoIcon className="size-4" />
          <p className="text-sm">{title}</p>
          <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]:rotate-180" />
        </div>
      </TaskTrigger>
      <TaskContent>
        {rows.map((t) => (
          <TaskItem key={t.id}>
            <span className="task-glyph" data-status={t.status} aria-hidden>
              {TASK_GLYPH[t.status] ?? "•"}
            </span>{" "}
            {t.title}
            {t.detail ? <span className="tool-note-snip"> — {t.detail}</span> : null}
          </TaskItem>
        ))}
      </TaskContent>
    </Task>
  );
}

/**
 * Aggregate the RAG sources already carried in this message's tool outputs (understory_* /
 * search_graph), deduped by kind+title+url — for the collapsible `Sources` list under the
 * answer. Reuses data we already render in the timeline cards.
 */
export function collectSources(parts: Part[]): Source[] {
  const out: Source[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    if (!isTool(p) || p.state !== "output-available") continue;
    const srcs = (p.output?.sources ?? []) as Source[];
    for (const s of srcs) {
      if (!s || !s.title) continue;
      const key = `${s.kind}:${s.title}:${s.url ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
  }
  return out;
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
  if (notes.length === 0) return <div className="tool-card"><span className="tool-card-kicker kicker">🔎 No matching private context</span></div>;
  return (
    <div className="tool-card">
      <span className="tool-card-kicker kicker kicker-sage">🔎 From private context</span>
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

function outputText(output: { text?: unknown; content?: unknown }): string {
  if (typeof output.text === "string") return output.text;
  if (typeof output.content === "string") return output.content;
  if (Array.isArray(output.content)) {
    return output.content
      .map((item) => (item && typeof item === "object" && "text" in item && typeof item.text === "string" ? item.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function stripAppleNotesMarkup(text: string): string {
  return text
    .replace(/<\/div>\s*<div>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?div>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function compactId(id?: string): string {
  if (!id) return "";
  const tail = id.match(/\/([^/]+)$/)?.[1] ?? id;
  return tail.length > 24 ? `${tail.slice(0, 10)}…${tail.slice(-8)}` : tail;
}

function appleNotesHref(openUrl?: string): string | null {
  return openUrl?.startsWith("applenotes://") ? openUrl : null;
}

export function AppleNotesOpenLink({
  id,
  openUrl,
  children = "Open in Notes",
  className = "apple-note-open",
  fallback = null,
}: {
  id?: string;
  openUrl?: string;
  children?: ReactNode;
  className?: string;
  fallback?: ReactNode;
}) {
  const [href, setHref] = useState<string | null>(() => appleNotesHref(openUrl));
  useEffect(() => {
    const direct = appleNotesHref(openUrl);
    if (direct) {
      setHref(direct);
      return;
    }
    if (!id) {
      setHref(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/leash/apple-notes/open-url?id=${encodeURIComponent(id)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { openUrl?: string } | null) => {
        if (!cancelled) setHref(appleNotesHref(data?.openUrl));
      })
      .catch(() => {
        if (!cancelled) setHref(null);
      });
    return () => {
      cancelled = true;
    };
  }, [id, openUrl]);
  return href ? (
    <a className={className} href={href}>
      {children}
    </a>
  ) : fallback ? (
    <span>{fallback}</span>
  ) : null;
}

function formatNoteDate(v?: string): string {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

function AppleNoteRows({ notes }: { notes: AppleNoteRow[] }) {
  return (
    <div className="apple-notes-list">
      {notes.map((note, i) => {
        const snip = stripAppleNotesMarkup(note.content ?? "");
        const meta = [note.account, note.folder, formatNoteDate(note.modified ?? note.created), compactId(note.id)].filter(Boolean).join(" · ");
        const href = appleNotesHref(note.openUrl);
        return (
          <div key={note.id ?? `${note.title}-${i}`} className="apple-note-row">
            <span className="apple-note-title">{note.title || "Untitled note"}</span>
            {meta ? <span className="apple-note-meta">{meta}</span> : null}
            {snip ? <span className="apple-note-preview">{snip}</span> : null}
            <AppleNotesOpenLink id={note.id} openUrl={href ?? undefined} />
          </div>
        );
      })}
    </div>
  );
}

function AppleNotePreview({ title, text, id, openUrl }: { title?: string; text: string; id?: string; openUrl?: string }) {
  const clean = stripAppleNotesMarkup(text);
  const href = appleNotesHref(openUrl);
  return (
    <div className="apple-note-preview-card">
      <div className="apple-note-preview-head">
        <span className="apple-note-title">{title || "Untitled note"}</span>
        {id ? <span className="apple-note-meta">{compactId(id)}</span> : null}
      </div>
      <pre className="apple-note-body">{clean || "No note content returned."}</pre>
      <AppleNotesOpenLink id={id} openUrl={href ?? undefined} />
    </div>
  );
}

function AppleNotesReceipt({ name, input, output }: { name: string; input: Record<string, unknown>; output: Record<string, unknown> }) {
  const text = outputText(output);
  const title = String(input["newTitle"] ?? input["title"] ?? text.match(/"([^"]+)"/)?.[1] ?? "Apple Note");
  const id = String(input["id"] ?? text.match(/x-coredata:\/\/\S+/)?.[0]?.replace(/\]$/, "") ?? "");
  const href = appleNotesHref(typeof output["openUrl"] === "string" ? output["openUrl"] : undefined);
  const label =
    name === "create-note" ? "Created" : name === "update-note" ? "Updated" : name === "delete-note" ? "Deleted" : name === "move-note" ? "Moved" : "Completed";
  return (
    <div className="apple-note-receipt">
      <CircleCheckIcon className="apple-note-receipt-icon" aria-hidden />
      <div>
        <span className="apple-note-title">{label}: {title}</span>
        {id ? <span className="apple-note-meta">{compactId(id)}</span> : null}
        {text && !text.includes(title) ? <span className="apple-note-preview">{text}</span> : null}
        <AppleNotesOpenLink id={id} openUrl={href ?? undefined} />
      </div>
    </div>
  );
}

function AppleNotesCard({ name, input, output }: { name: string; input: Record<string, unknown>; output: Record<string, unknown> }) {
  const notes = (Array.isArray(output["notes"]) ? output["notes"] : Array.isArray(output["results"]) ? output["results"] : []) as AppleNoteRow[];
  const count = typeof output["count"] === "number" ? output["count"] : notes.length;
  const text = outputText(output);
  const title = typeof output["title"] === "string" ? output["title"] : typeof input["title"] === "string" ? input["title"] : undefined;
  const inputId = typeof input["id"] === "string" ? input["id"] : undefined;
  const openUrl = typeof output["openUrl"] === "string" ? output["openUrl"] : undefined;

  if (name === "search-notes" || name === "list-notes") {
    return (
      <div className="tool-card apple-notes-card">
        <span className="tool-card-kicker kicker kicker-sage">Apple Notes · {count} found</span>
        {notes.length ? <AppleNoteRows notes={notes} /> : <span className="tool-note-snip">{text || "No matching notes returned."}</span>}
      </div>
    );
  }

  if (name === "get-note-content" || name === "get-note-details" || name === "get-note-by-id") {
    return (
      <div className="tool-card apple-notes-card">
        <span className="tool-card-kicker kicker kicker-sage">Apple Notes · note content</span>
        <AppleNotePreview title={title} text={text} id={inputId} openUrl={openUrl} />
      </div>
    );
  }

  if (name === "create-note" || name === "update-note" || name === "delete-note" || name === "move-note") {
    return (
      <div className="tool-card apple-notes-card">
        <span className="tool-card-kicker kicker kicker-sage">Apple Notes · write result</span>
        <AppleNotesReceipt name={name} input={input} output={output} />
      </div>
    );
  }

  return (
    <div className="tool-card apple-notes-card">
      <span className="tool-card-kicker kicker kicker-sage">Apple Notes · {DONE_LABEL[name] ?? name}</span>
      <span className="tool-note-snip">{text || JSON.stringify(output, null, 2)}</span>
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
    <Confirmation approval={part.approval} state={part.state} className="tool-approval-card">
      <ConfirmationTitle>
        <span className="tool-card-kicker kicker kicker-sage">⏸ Approval needed · {name}</span>
      </ConfirmationTitle>
      <ConfirmationRequest>
        <pre className="tool-approval-input">{pretty}</pre>
      </ConfirmationRequest>
      <ConfirmationActions>
        {approval && part.approval?.id ? (
          <>
            <ConfirmationAction
              variant="outline"
              onClick={() => {
                approval.respond({ id: part.approval.id, approved: false, reason: "denied by user" });
                toast.info("Tool denied");
              }}
            >
              ✕ Deny
            </ConfirmationAction>
            <ConfirmationAction
              onClick={() => {
                approval.respond({ id: part.approval.id, approved: true });
                toast.success("Tool approved");
              }}
            >
              ✓ Approve &amp; run
            </ConfirmationAction>
          </>
        ) : (
          <span className="kicker" style={{ color: "var(--color-faint)" }}>awaiting a decision</span>
        )}
      </ConfirmationActions>
    </Confirmation>
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
