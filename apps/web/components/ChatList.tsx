import { listChats, loadConsolidations } from "../lib/leash/chat-store.ts";
import { ChatTrayPanel } from "./ChatTrayPanel.tsx";

/**
 * Loads chat history + dreaming consolidations (server) and hands them to the interactive
 * tray. Empty chats are hidden (except the active one); the "To work on" section only
 * renders when the dreaming service has written consolidations (else honest-empty).
 */
export async function ChatList({ activeId }: { activeId: string }) {
  const [chats, dreams] = await Promise.all([listChats(), loadConsolidations()]);
  const visible = chats.filter((c) => c.messageCount > 0 || c.id === activeId);
  return <ChatTrayPanel chats={visible} dreams={dreams} activeId={activeId} />;
}
