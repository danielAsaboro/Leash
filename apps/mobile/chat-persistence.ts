import type { StoredMessage } from "./chats";

export type PersistedChatSnapshot = {
  id: string;
  messages: string;
};

export function snapshotChat(id: string, messages: StoredMessage[]): PersistedChatSnapshot {
  return { id, messages: JSON.stringify(messages) };
}

export function chatNeedsSave(
  persisted: PersistedChatSnapshot | null,
  id: string,
  messages: StoredMessage[],
): boolean {
  if (!id || messages.length === 0) return false;
  return persisted?.id !== id || persisted.messages !== JSON.stringify(messages);
}
