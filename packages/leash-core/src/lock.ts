/**
 * Cross-process advisory file lock (server-side library code — no `server-only`).
 *
 * The JSON stores (memories, tasks, tombstones) used to be single-writer (the Next
 * process only), guarded by an in-process promise-mutex. Now the `leash-tools-mcp`
 * daemon ALSO writes them, so a read-modify-write in one process can clobber the other's
 * (atomic tmp+rename prevents torn files, but not lost UPDATES). This is a tiny `O_EXCL`
 * lockfile around each mutation: only two writers contend (web + daemon), so a short
 * retry budget with stale-lock reclamation is sufficient and dependency-free.
 *
 * The in-process mutex stays as the fast path; this nests INSIDE it (so concurrent calls
 * within one process queue locally, and only one cross-process acquire happens per batch).
 */
import { open, unlink, stat } from "node:fs/promises";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface FileLockOptions {
  /** Max acquire attempts before giving up (default 200 ≈ ~4s at the default backoff). */
  retries?: number;
  /** A lock older than this is presumed orphaned (crashed holder) and reclaimed. */
  staleMs?: number;
}

/**
 * Run `fn` while holding an exclusive lock on `<target>.lock`. The lock is always released
 * (even if `fn` throws). On contention we retry with a small jittered backoff; a lock older
 * than `staleMs` is reclaimed (a crashed writer must never wedge the store forever).
 */
export async function withFileLock<T>(target: string, fn: () => Promise<T>, opts: FileLockOptions = {}): Promise<T> {
  const lockPath = `${target}.lock`;
  const retries = opts.retries ?? 200;
  const staleMs = opts.staleMs ?? 10_000;
  let acquired = false;
  for (let i = 0; i < retries && !acquired; i++) {
    try {
      const fh = await open(lockPath, "wx"); // O_CREAT|O_EXCL — fails if it exists
      await fh.close();
      acquired = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Someone holds it. Reclaim if it's stale; otherwise back off and retry.
      try {
        const s = await stat(lockPath);
        if (Date.now() - s.mtimeMs > staleMs) {
          await unlink(lockPath).catch(() => undefined);
          continue; // retry immediately after reclaiming
        }
      } catch {
        continue; // lock vanished between EEXIST and stat — retry the acquire now
      }
      await sleep(15 + Math.floor(Math.random() * 15));
    }
  }
  if (!acquired) throw new Error(`withFileLock: could not acquire ${lockPath} after ${retries} tries`);
  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => undefined);
  }
}
