/**
 * Per-chat lanes (OpenClaw-style): serialize turns within one chat so a slow agent turn can't
 * overlap the next message from the same chat (which would race the Leash thread / wedge the
 * serve). Different chats run in parallel. Fire-and-forget — the caller keeps receiving updates
 * while a lane drains.
 */
const chains = new Map<number, Promise<void>>();

export function runInLane(chatId: number, fn: () => Promise<void>): void {
  const prev = chains.get(chatId) ?? Promise.resolve();
  // Run `fn` whether or not the previous turn resolved or rejected; never let the chain reject.
  const next = prev.then(fn, fn).catch(() => undefined);
  chains.set(chatId, next);
  void next.finally(() => {
    if (chains.get(chatId) === next) chains.delete(chatId);
  });
}
