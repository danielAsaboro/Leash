/**
 * Telegram chat ↔ Leash conversation mapping. Deterministic by design: a chat's Leash id is
 * `telegram-<chatId>`, so context persists automatically across daemon restarts — the full
 * thread lives in the Leash web app's chat store under that stable key (no separate file to
 * keep in sync). Owner-only means effectively one chat, but this generalizes if the policy
 * ever opens up.
 */
export function leashChatIdFor(tgChatId: number): string {
  return `telegram-${tgChatId}`;
}
