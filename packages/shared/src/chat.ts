/**
 * Framework-agnostic chat primitives shared by every Mycelium client.
 *
 * This module is deliberately PURE and dependency-free (no @qvac/sdk, no React,
 * no Electron) so the exact same chat logic compiles in an Electron main process
 * (`apps/desktop`) AND a future Expo/React-Native app (`apps/mobile`) without a
 * rewrite. The SDK-coupled model registry stays in the app layer (it can't live
 * here — `shared` must not import the runtime); this is just the message model.
 *
 * Distinct from `ChatTurn` in kv-sessions.ts (that one is the KV-cache session
 * ledger shape); keep the two separate on purpose.
 */
import { SHARED_CHAT_SYSTEM_PROMPT } from "./prompt.ts";

export { SHARED_CHAT_SYSTEM_PROMPT } from "./prompt.ts";

/** One message in a chat transcript, in the shape `completion({ history })` expects. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * Build the `history` array handed to `completion()`. Prepends a single system
 * message (unless the caller already included one) and drops any empty messages
 * so a half-typed bubble never reaches the model.
 *
 * @param messages  The visible transcript (user/assistant turns, no system).
 * @param system    System prompt to lead with. Defaults to {@link SHARED_CHAT_SYSTEM_PROMPT}.
 */
export function buildHistory(
  messages: ChatMessage[],
  system: string = SHARED_CHAT_SYSTEM_PROMPT
): ChatMessage[] {
  const turns = messages.filter((m) => m.role !== 'system' && m.content.trim().length > 0)
  const hasSystem = messages.some((m) => m.role === 'system')
  return hasSystem ? [...messages] : [{ role: 'system', content: system }, ...turns]
}
