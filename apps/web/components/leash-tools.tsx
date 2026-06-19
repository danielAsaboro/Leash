"use client";
import Link from "next/link";
import { ChevronDownIcon, ClockIcon, ImageIcon, ListTodoIcon, SearchIcon, WrenchIcon, type LucideIcon } from "lucide-react";
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
 *   · search_graph                         → private-note snippet cards
 *   · now                                  → a date/time chip
 * Unknown tools (e.g. future MCP tools) fall back to the generic AI Elements <Tool>.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Part = any;
type Source = { kind: "graph" | "paper"; title: string; snippet: string; url?: string };

export const toolName = (p: Part): string => (p.type === "dynamic-tool" ? String(p.toolName) : String(p.type).slice("tool-".length));
const isTool = (p: Part): boolean => typeof p?.type === "string" && (p.type.startsWith("tool-") || p.type === "dynamic-tool");

const LOADING_LABEL: Record<string, string> = {
  search_graph: "Searching your notes…",
  understory_today: "Reading today's paper…",
  understory_search: "Searching the paper…",
  now: "Checking the time…",
  generate_image: "Painting your image (on-device)…",
  list_tasks: "Reading your task list…",
  create_task: "Adding a task…",
  update_task: "Updating a task…",
};

/** Label once a tool has produced output — past-tense, for the collapsed timeline node. */
const DONE_LABEL: Record<string, string> = {
  search_graph: "Searched your notes",
  understory_today: "Read today's paper",
  understory_search: "Searched the paper",
  now: "Checked the time",
  generate_image: "Generated an image",
  list_tasks: "Listed your tasks",
  create_task: "Created a task",
  update_task: "Updated a task",
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
        <span className="tool-card-kicker kicker kicker-sage">✓ Tasks</span>
        {output.text ? <span className="tool-note-snip">{output.text}</span> : null}
      </div>
    );
  }
  const title = rows.length === 1 ? rows[0]!.title : `${rows.length} tasks`;
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
