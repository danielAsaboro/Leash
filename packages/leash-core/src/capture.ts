/**
 * Screen capture (server-only) for the `screenshot` computer-use tool — macOS
 * `screencapture` to a per-call random temp file, returned as a base64 data URL and
 * DELETED in `finally` so no residual frames ever sit on disk.
 *
 * Mirrors `apps/leash-watch/src/capture.ts`, except the watcher writes one fixed
 * FRAME_PATH (single periodic caller) while chat tool calls can overlap — so each
 * call here gets its own random filename under `$TMPDIR/leash/`.
 *
 * `CaptureError` signals a permission/empty-frame problem (the tool surfaces the
 * hint as honest text instead of crashing the turn).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, unlink, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execFileP = promisify(execFile);

export class CaptureError extends Error {}

/** Capture the active screen, return a `data:image/png;base64,…` URL, then delete the PNG. */
export async function captureScreen(): Promise<string> {
  const dir = join(tmpdir(), "leash");
  const framePath = join(dir, `frame-${randomUUID()}.png`);
  await mkdir(dir, { recursive: true });
  try {
    await execFileP("screencapture", ["-x", "-o", framePath]);
    const buf = await readFile(framePath);
    if (buf.length === 0) {
      throw new CaptureError("captured frame is empty — grant Screen Recording permission to this terminal.");
    }
    return `data:image/png;base64,${buf.toString("base64")}`;
  } catch (err) {
    if (err instanceof CaptureError) throw err;
    throw new CaptureError(`screen capture failed (grant Screen Recording permission): ${String(err).slice(0, 160)}`);
  } finally {
    await unlink(framePath).catch(() => {});
  }
}
