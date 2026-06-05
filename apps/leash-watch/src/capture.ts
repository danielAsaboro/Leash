/**
 * Screen capture via macOS `screencapture`. Returns the frame as a base64 data URL
 * and DELETES the PNG in `finally` — no residual frames ever sit on disk.
 *
 * `CaptureError` signals a permission/empty-frame problem (the watcher skips the tick
 * and prints a hint rather than crashing).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, unlink, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { FRAME_PATH } from "./config.ts";

const execFileP = promisify(execFile);

export class CaptureError extends Error {}

/** Capture the active screen to FRAME_PATH, return a `data:image/png;base64,…` URL, then delete the PNG. */
export async function captureScreen(): Promise<string> {
  await mkdir(dirname(FRAME_PATH), { recursive: true });
  try {
    await execFileP("screencapture", ["-x", "-o", FRAME_PATH]);
    const buf = await readFile(FRAME_PATH);
    if (buf.length === 0) {
      throw new CaptureError("captured frame is empty — grant Screen Recording permission to this terminal.");
    }
    return `data:image/png;base64,${buf.toString("base64")}`;
  } catch (err) {
    if (err instanceof CaptureError) throw err;
    throw new CaptureError(`screen capture failed (grant Screen Recording permission): ${String(err).slice(0, 160)}`);
  } finally {
    await unlink(FRAME_PATH).catch(() => {});
  }
}
