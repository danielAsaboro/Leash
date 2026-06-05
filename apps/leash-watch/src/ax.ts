/**
 * Accessibility (AX) context — the frontmost app name + front window title via
 * `osascript`, and the user's idle time via `ioreg`'s HIDIdleTime.
 *
 * Degrades gracefully: if Accessibility isn't granted (or the app has no window) the
 * window title comes back empty and we keep the app-only context. Idle time lets the
 * watcher skip ticks while the user is away or the screen is locked.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

async function osa(script: string): Promise<string> {
  const { stdout } = await execFileP("osascript", ["-e", script]);
  return stdout.trim();
}

export interface AxContext {
  app: string;
  window: string;
}

/** Frontmost app name + front window title (window degrades to "" without Accessibility). */
export async function frontmost(): Promise<AxContext> {
  let app = "";
  try {
    app = await osa('tell application "System Events" to get name of first application process whose frontmost is true');
  } catch {
    app = "";
  }
  let window = "";
  try {
    window = await osa(
      'tell application "System Events" to tell (first application process whose frontmost is true) to get name of front window',
    );
  } catch {
    window = ""; // Accessibility ungranted, or the app exposes no front window
  }
  return { app, window };
}

/** Seconds since the last HID input (0 on any failure). Used to skip ticks when away/locked. */
export async function idleSeconds(): Promise<number> {
  try {
    const { stdout } = await execFileP("sh", ["-c", "ioreg -c IOHIDSystem | grep -m1 HIDIdleTime"]);
    const m = stdout.match(/"HIDIdleTime"\s*=\s*(\d+)/);
    if (!m) return 0;
    return Math.round(Number(m[1] ?? 0) / 1_000_000_000); // HIDIdleTime is in nanoseconds
  } catch {
    return 0;
  }
}
