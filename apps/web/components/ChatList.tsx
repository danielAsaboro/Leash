import { listChats } from "../lib/leash/chat-store.ts";
import { listTasks } from "../lib/leash/tasks-store.ts";
import { ChatTrayPanel } from "./ChatTrayPanel.tsx";

/**
 * Loads chat history + open tasks (server) and hands them to the interactive tray.
 * Empty chats are hidden (except the active one); the "To work on" section shows the
 * task store's open items (user + assistant + dream sources — else honest-empty).
 */
export async function ChatList({ activeId }: { activeId: string }) {
  const [chats, openTasks] = await Promise.all([listChats(), listTasks({ status: "open" })]);
  const visible = chats.filter((c) => c.messageCount > 0 || c.id === activeId);
  return <ChatTrayPanel chats={visible} dreams={openTasks.slice(0, 6)} activeId={activeId} />;
}
