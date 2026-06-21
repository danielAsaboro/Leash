/**
 * Message IDs must remain unique across app launches because persisted conversations are restored
 * before a new turn is appended. A process-local counter restarts at `m1` and makes streamed updates
 * rewrite every older message with the same ID.
 */
export function createMessageIdFactory(
  now: () => number = Date.now,
  random: () => number = Math.random,
): () => string {
  const session = `${now().toString(36)}-${Math.floor(random() * 0x1_0000_0000)
    .toString(36)
    .padStart(7, "0")}`;
  let sequence = 0;
  return () => `m-${session}-${(++sequence).toString(36)}`;
}

export const makeMessageId = createMessageIdFactory();
