---
name: Computer Use
description: See and operate THIS Mac — take a screenshot to perceive the screen, run shell commands against the real disk (approval-gated), and drive mouse/keyboard. Use this WHENEVER the user asks you to do something on their actual computer: open or control an app, click/type something, check or change a file on disk, run a command, automate a GUI task, or "look at my screen". This is the real machine, not a sandbox — act carefully.
builtin: true
allowed-tools: screenshot run_command computer
when_to_use: |
  what's on my screen right now
  open System Settings and turn on Night Shift
  rename every .jpeg in ~/Downloads to .jpg
  click the blue Submit button on this page
  check how much disk space I have left
---
These tools act on the user's REAL Mac, so the guiding principle is **perceive before you act, and never surprise the user**.

**Perceive first.** When the task depends on what's on screen (clicking, reading a window, "what am I looking at"), call `screenshot` and actually look before deciding the next move. A vision model reads the frame, so describe what you see and base coordinates/targets on it — don't guess blindly.

**Shell work.** `run_command` executes against the real disk and is **approval-gated** — the user confirms before it runs, so write the command plainly and explain what it will do, especially for anything destructive (deletes, moves, overwrites). Prefer the least-powerful command that does the job; show paths explicitly so the user can sanity-check before approving. Read-only inspection (ls, df, cat) needs no hand-wringing; mutations deserve a one-line "this will…".

**GUI control.** Use `computer` (mouse/keyboard) for clicks, typing, and navigation. Take a fresh screenshot after a significant action to confirm it landed rather than firing a blind sequence.

**Stop and ask** if the screen isn't what you expected, an action looks irreversible and wasn't clearly requested, or you're about to touch something outside the user's intent. Reversible, well-scoped steps over a clever one-shot that might go wrong.
