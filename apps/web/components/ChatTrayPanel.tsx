"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { fetchWithTimeout } from "../lib/http.ts";
import { appPrompt } from "../lib/prompt.ts";
import { toast } from "./Toast.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import type { ChatSummary, ConsolidationItem } from "../lib/leash/types";

/**
 * The interactive chat history tray (client). Lists previous conversations with
 * delete/rename actions, and — above them — a "To work on" section fed by the dreaming
 * service's consolidations (hidden until that store has entries). The `.chat-tray`
 * positioning/reveal lives in globals.css (edge-peek drawer on the right).
 */

function relTime(ms: number): string {
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function ChatTrayPanel({ chats, dreams, activeId }: { chats: ChatSummary[]; dreams: ConsolidationItem[]; activeId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const call = async (fn: () => Promise<Response>, { refresh = true } = {}) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Request failed (${res.status}).`);
        return false;
      }
      if (refresh) router.refresh();
      return true;
    } catch {
      setError("Request failed — is the app still running?");
      return false;
    } finally {
      setBusy(false);
    }
  };

  // Deletion is gated by a real confirmation dialog (not the native confirm()). The button opens it;
  // `confirmDelete` does the work, toasts the outcome, and — if the OPEN chat was deleted — starts a
  // FRESH conversation (not `/chat`, which would resume the most recent existing one).
  const [pendingDelete, setPendingDelete] = useState<{ id: string; title: string } | null>(null);
  const requestDelete = (id: string, title: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setPendingDelete({ id, title });
  };
  const confirmDelete = async () => {
    if (!pendingDelete || busy) return;
    const { id: delId } = pendingDelete;
    setBusy(true);
    setError(null);
    try {
      const res = await fetchWithTimeout(`/api/leash/chats/${delId}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setPendingDelete(null);
      toast.success("Conversation deleted");
      if (delId === activeId) router.push("/chat/new");
      else router.refresh();
    } catch {
      toast.error("Couldn't delete the conversation — try again.");
    } finally {
      setBusy(false);
    }
  };

  const rename = async (id: string, current: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const title = await appPrompt("Rename conversation", current, { inputLabel: "Conversation title" });
    if (title == null || !title.trim()) return;
    await call(() => fetchWithTimeout(`/api/leash/chats/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) }));
  };

  return (
    <aside className="chat-tray" aria-label="Chat history">
      <div className="chat-tray-handle kicker" aria-hidden>
        Chats
      </div>
      <Link href="/chat/new" className="chat-list-new kicker">
        ＋ New chat
      </Link>

      {error && (
        <p className="kicker px-3 py-1" style={{ color: "var(--color-brick)" }} role="alert">
          {error}
        </p>
      )}

      {dreams.length > 0 && (
        <div className="chat-dreams">
          <p className="chat-dreams-title kicker">To work on</p>
          {dreams.map((d, i) => (
            // Composite key: consolidation-store items can carry empty or duplicate ids (legacy
            // migration stamped `id: d.id || generateId()`), so the index guarantees uniqueness.
            <div key={`${d.id || "dream"}-${i}`} className="chat-dream" title={d.detail ?? ""}>
              <span className="chat-dream-dot" aria-hidden />
              <span className="chat-dream-text">{d.title}</span>
            </div>
          ))}
        </div>
      )}

      <nav className="chat-list-items">
        {chats.length === 0 ? (
          <p className="chat-list-empty kicker">No conversations yet</p>
        ) : (
          chats.map((c, i) => (
            // Composite key: guard against an empty/duplicate id in the stored list so React never warns.
            <div key={`${c.id || "chat"}-${i}`} className={`chat-list-item ${c.id === activeId ? "is-active" : ""}`}>
              <Link href={`/chat/${c.id}`} className="chat-list-link">
                <span className="chat-list-title">{c.title}</span>
                <span className="chat-list-time" suppressHydrationWarning>
                  {relTime(c.updatedAt)}
                </span>
              </Link>
              <span className="chat-list-actions">
                <button type="button" onClick={(e) => void rename(c.id, c.title, e)} title="Rename" aria-label="Rename conversation" disabled={busy}>
                  ✎
                </button>
                <button type="button" onClick={(e) => requestDelete(c.id, c.title, e)} title="Delete" aria-label="Delete conversation" disabled={busy}>
                  ×
                </button>
              </span>
            </div>
          ))
        )}
      </nav>

      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(o) => {
          if (!o) setPendingDelete(null);
        }}
        title="Delete conversation?"
        description={pendingDelete ? <>“{pendingDelete.title}” and all its messages will be permanently deleted. This can’t be undone.</> : undefined}
        confirmLabel="Delete"
        destructive
        busy={busy}
        onConfirm={() => void confirmDelete()}
      />
    </aside>
  );
}
