/**
 * Persists the user's chosen chat model (its `chatKey`) — the phone analogue of the web's
 * per-conversation model picker, but GLOBAL (mobile reloads weights locally, so one active model).
 * Best-effort JSON in the app's document directory; a missing/corrupt file falls back to the default.
 */
import * as FileSystem from "expo-file-system/legacy";
import { DEFAULT_CHAT_KEY } from "./modelsInventory";

const FILE = `${FileSystem.documentDirectory}selectedModel.json`;

export async function getSelectedChatKey(): Promise<string> {
  try {
    const info = await FileSystem.getInfoAsync(FILE);
    if (!info.exists) return DEFAULT_CHAT_KEY;
    const data = JSON.parse(await FileSystem.readAsStringAsync(FILE)) as { chatKey?: string };
    return typeof data.chatKey === "string" && data.chatKey ? data.chatKey : DEFAULT_CHAT_KEY;
  } catch {
    return DEFAULT_CHAT_KEY;
  }
}

export async function setSelectedChatKey(chatKey: string): Promise<void> {
  try {
    await FileSystem.writeAsStringAsync(FILE, JSON.stringify({ chatKey }));
  } catch {
    /* best-effort */
  }
}
