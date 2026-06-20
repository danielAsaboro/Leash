# Open Computer Use Troubleshooting

First checks:

```sh
open-computer-use -h
open-computer-use doctor
open-computer-use call list_apps
```

On macOS, `doctor` reports Accessibility and Screen Recording status. If either is missing, ask the user to approve the onboarding UI.

If an app is not found:

1. Run `list_apps`.
2. Use the app name or bundle identifier from that result.
3. Confirm the app is running and has a visible, non-minimized window.
4. On macOS, rerun `doctor`.

Do not silently switch to a different app when the requested target is not available.

Common causes of empty or missing state:

- The app has no visible window.
- The window is minimized, hidden, or on another desktop.
- macOS Screen Recording permission is missing.
- Windows or Linux commands are running outside the logged-in desktop session.
- Linux screenshot support is blocked by compositor or portal state.

If an element action fails:

1. Re-run `get_app_state`.
2. Confirm the `element_index` still exists and refers to the intended UI element.
3. Prefer `set_value` for settable text/value controls.
4. Prefer `perform_secondary_action` only for actions exposed in the state result.
5. Use coordinate-style `click`, `scroll`, or `drag` only after the semantic route is unavailable.

Do not enable global pointer fallbacks unless the user explicitly asks for low-level diagnostics. Do not interact with password managers or sensitive apps unless the user explicitly requests it.
