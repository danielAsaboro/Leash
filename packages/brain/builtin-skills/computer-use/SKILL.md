---
name: computer-use
description: See and operate THIS Mac through Open Computer Use's local MCP server. Use this WHENEVER the user asks you to inspect or control their actual desktop: list apps, read an app's UI state, click/type/scroll/drag, set fields, press keys, automate a GUI task, or "look at my screen". This is the real machine, not a sandbox — act carefully.
metadata: |
  {"builtin":true}
allowed-tools: list_apps get_app_state click perform_secondary_action scroll drag type_text press_key set_value
paths: references/installation.md references/usage.md references/troubleshooting.md
when_to_use: |
  what's on my screen right now
  open System Settings and turn on Night Shift
  rename every .jpeg in ~/Downloads to .jpg
  click the blue Submit button on this page
  look at TextEdit and type a short note
---
These tools act on the user's REAL Mac, so the guiding principle is **perceive before you act, and never surprise the user**.

Open Computer Use is a local CLI and stdio MCP server. If installation, permissions, direct CLI calls, or platform behavior matters, read the attached references before acting:

- `references/installation.md` for one-time package setup and macOS permissions.
- `references/usage.md` for MCP tool names, direct call patterns, and platform notes.
- `references/troubleshooting.md` for permission, desktop-session, app discovery, and action failures.

**Perceive first.** Call `list_apps` to choose a visible target, then `get_app_state` for that app before clicking, typing, or setting values. Re-run `get_app_state` after navigation, modal changes, page reloads, or failed actions.

**Use semantic targets.** Prefer `element_index` values from the latest `get_app_state` result. Use `set_value` for editable fields, `type_text` for focused insertion, `press_key` for keyboard navigation, and coordinate-style actions only when the app state does not expose a safer target.

**Long text.** When the user needs complete visible text, chat history, email body text, document content, or form values, call `get_app_state` with `show_full_text: true`.

**Approval boundary.** Actions that change the GUI need approval. Explain the intended action plainly, and if approval is denied, do not retry the same call.

**Stop and ask** if the screen isn't what you expected, an action looks irreversible and wasn't clearly requested, or you're about to touch something outside the user's intent. Reversible, well-scoped steps over a clever one-shot that might go wrong.
