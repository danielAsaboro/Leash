"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
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

  const del = async (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm("Delete this conversation?")) return;
    await fetch(`/api/leash/chats/${id}`, { method: "DELETE" });
    if (id === activeId) router.push("/chat");
    else router.refresh();
  };

  const rename = async (id: string, current: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const title = prompt("Rename conversation", current);
    if (title == null || !title.trim()) return;
    await fetch(`/api/leash/chats/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) });
    router.refresh();
  };

  return (
    <aside className="chat-tray" aria-label="Chat history">
      <div className="chat-tray-handle kicker" aria-hidden>
        Chats
      </div>
      <Link href="/chat/new" className="chat-list-new kicker">
        ＋ New chat
      </Link>

      {dreams.length > 0 && (
        <div className="chat-dreams">
          <p className="chat-dreams-title kicker">To work on</p>
          {dreams.map((d) => (
            <div key={d.id} className="chat-dream" title={d.detail ?? ""}>
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
          chats.map((c) => (
            <div key={c.id} className={`chat-list-item ${c.id === activeId ? "is-active" : ""}`}>
              <Link href={`/chat/${c.id}`} className="chat-list-link">
                <span className="chat-list-title">{c.title}</span>
                <span className="chat-list-time" suppressHydrationWarning>
                  {relTime(c.updatedAt)}
                </span>
              </Link>
              <span className="chat-list-actions">
                <button type="button" onClick={(e) => rename(c.id, c.title, e)} title="Rename" aria-label="Rename conversation">
                  ✎
                </button>
                <button type="button" onClick={(e) => del(c.id, e)} title="Delete" aria-label="Delete conversation">
                  ×
                </button>
              </span>
            </div>
          ))
        )}
      </nav>
    </aside>
  );
}
