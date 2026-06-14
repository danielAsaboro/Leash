---
name: Task Manager
description: Manage the user's to-do list — create tasks, list what's open or in progress, and update status/priority. Use this WHENEVER the user wants to track something to do: "remind me to…", "add a task", "what's on my list", "mark that done", "what should I work on next". Capture commitments as tasks so they don't get lost between conversations.
builtin: true
allowed-tools: create_task list_tasks update_task
when_to_use: |
  remind me to renew the domain before Friday
  what's on my to-do list
  add a task to review the lease and another to call the plumber
  mark the lease review done
  what should I tackle next
---
The user's task list is shared state across conversations — treat it as the source of truth for what they've committed to, not a scratchpad.

**Create** a task when the user expresses something they intend to do ("remind me to…", "I need to…", "add a task"). Give it a clear, action-oriented title; add a short detail only if it carries real information. If they mention several things, create several tasks rather than cramming them into one.

**List** with `list_tasks` before answering "what's on my list / what's next / what's still open" — and before creating, so you don't duplicate an existing task. Filter by status when they ask specifically (open vs in-progress vs done).

**Update** status as work moves: mark done when they say it's finished, in-progress when they start, and bump priority when they flag something urgent. When they say "I finished the X", find the matching task and close it rather than asking them to specify an id.

Keep it lightweight — the point is that nothing they meant to do quietly disappears.
