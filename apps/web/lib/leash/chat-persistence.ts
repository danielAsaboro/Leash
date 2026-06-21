/** Pure idempotence predicate shared by persistence and its regression test. */
export function chatMessagesChanged(previous: unknown[], next: unknown[]): boolean {
  return JSON.stringify(previous) !== JSON.stringify(next);
}
