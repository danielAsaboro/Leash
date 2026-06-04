import { loadChat, chatExists } from "../../../lib/leash/chat-store.ts";
import { LeashChat } from "../../../components/LeashChat.tsx";
import { ChatList } from "../../../components/ChatList.tsx";

/** A persisted Leash conversation. The history tray is an edge-peek overlay (right side). */
export const dynamic = "force-dynamic";

export default async function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // An unknown id just starts empty (the store is written on the first turn).
  const initialMessages = (await chatExists(id)) ? await loadChat(id) : [];

  return (
    <>
      <div className="chat-shell">
        <header className="reader-header">
          <div className="mx-auto flex max-w-[760px] items-baseline justify-between px-5 py-4">
            <div>
              <span className="kicker kicker-sage">Leash · Assistant</span>
              <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: "1.6rem", lineHeight: 1 }}>Leash</h1>
            </div>
            <p className="kicker" style={{ color: "var(--color-faint)" }}>On-device · Private</p>
          </div>
          <div className="mx-auto max-w-[760px] px-5">
            <div className="border-t-2" style={{ borderColor: "var(--color-ink)" }} />
            <div className="mt-[2px] border-t" style={{ borderColor: "var(--color-ink)" }} />
          </div>
        </header>

        <LeashChat id={id} initialMessages={initialMessages} />
      </div>

      {/* Right-edge hot zone: nudging the cursor to the far right reveals the tray. */}
      <div className="chat-tray-edge" aria-hidden />
      <ChatList activeId={id} />
    </>
  );
}
