/**
 * Keyboard controls + the visible "👁 watching" / "⏸ paused" indicator.
 *
 * Raw-mode stdin keypresses (TTY only): `p`/space pause-toggle, `f`/`F` forget 5/60 min,
 * `q`/Ctrl-C quit. Without a TTY (e.g. piped/launchd) this is a no-op and the watcher
 * runs unpaused — use the `--forget <min>` CLI flag for non-interactive forgetting.
 */

export interface Controls {
  /** Is the watcher currently paused? */
  paused: () => boolean;
  /** Redraw the status indicator (call after printing a line so it stays visible). */
  render: () => void;
}

export interface ControlHandlers {
  onForget: (minutes: number) => void;
  onQuit: () => void;
}

export function setupControls(handlers: ControlHandlers): Controls {
  let paused = false;
  const stdin = process.stdin;

  const render = (): void => {
    if (!stdin.isTTY) return;
    process.stdout.write(`\r${paused ? "⏸ paused " : "👁 watching"}  [p pause · f/F forget 5/60m · q quit]   `);
  };

  if (!stdin.isTTY) {
    return { paused: () => paused, render };
  }

  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  render();

  stdin.on("data", (key: string) => {
    if (key === "p" || key === " ") {
      paused = !paused;
      render();
    } else if (key === "f") {
      handlers.onForget(5);
      render();
    } else if (key === "F") {
      handlers.onForget(60);
      render();
    } else if (key === "q" || key === "\u0003") {
      // Ctrl-C in raw mode doesn't raise SIGINT, so route it to quit ourselves.
      handlers.onQuit();
    }
  });

  return { paused: () => paused, render };
}
