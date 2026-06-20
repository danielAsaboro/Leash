# Open Computer Use Usage

The MCP server exposes these tools:

```text
list_apps
get_app_state
click
perform_secondary_action
scroll
drag
type_text
press_key
set_value
```

Core workflow:

1. Call `list_apps`.
2. Pick the visible target app by app name or bundle identifier.
3. Call `get_app_state` for that app.
4. Prefer `element_index` actions from the latest state result.
5. Re-run `get_app_state` after navigation, modal changes, page reloads, or failed actions.

Use `get_app_state` with `show_full_text: true` when the task depends on complete text such as chat history, email bodies, document text, or long form content.

Prefer semantic actions:

- `set_value` for editable fields.
- `type_text` for focused insertion.
- `press_key` for keyboard navigation.
- `click`, `scroll`, and `drag` only when the element tree does not expose a safer target.
- `perform_secondary_action` only for actions exposed in the latest state result.

Direct CLI checks use the same local runtime:

```sh
open-computer-use call list_apps
open-computer-use call get_app_state --args '{"app":"TextEdit"}'
open-computer-use call set_value --args '{"app":"TextEdit","element_index":"1","value":"Draft"}'
```

For short local sequences that need to reuse element-index state in one process:

```sh
open-computer-use call --calls '[
  {"tool":"get_app_state","args":{"app":"TextEdit"}},
  {"tool":"click","args":{"app":"TextEdit","element_index":"1"}},
  {"tool":"type_text","args":{"app":"TextEdit","text":"Hello"}}
]'
```

Pause before actions that affect external systems or sensitive local state, including sending messages, submitting forms, deleting files, approving prompts, uploading files, or interacting with password managers.
