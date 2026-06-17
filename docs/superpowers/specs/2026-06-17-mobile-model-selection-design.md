# Phase D — Mobile model selection (every platform)

**Date:** 2026-06-17
**Status:** Design — approved for planning
**Layer:** Clients (apps/mobile, React Native / Expo / JSC)
**Part of:** the unified-agents direction. See [[agents-unified-architecture]]. Phases A–C built the
agent model + delegate runtime (web/desktop). Phase D closes the cross-platform gap.

## Why

The product rule (stated emphatically 2026-06-17): **no agent picker on any platform — Leash does
the orchestration; the only thing a user selects is the model.** Web/desktop already have a
per-conversation model picker. **Mobile is hardcoded to one chat model (Qwen3-1.7B) with no way to
change it.** Phase D fixes that inconsistency: mobile gets model selection. (Desktop is the web app
in an Electron `BrowserWindow`, so it already has the web picker — no desktop work.)

## What we learned (the platform reality)

- `apps/mobile` is a standalone RN/Expo/JSC app that **cannot import `leash-core`** (Node built-ins)
  and **runs its own on-device `@qvac/sdk` `completion()` loop** — no HTTP API.
- It already has the building blocks: `modelsInventory.ts` (a `MODELS` catalog + `probeModel`/
  `listModels`/`redownload`), the `prompts.ts` persistence pattern (expo-file-system JSON), and
  `ModelsPanel.tsx` (load/unload UI for STT/TTS).
- **The platform-forced divergence:** web passes a model *alias* to a server that hot-loads it
  (cheap, per-conversation). Mobile must **reload weights locally** (`unloadModel` → `downloadAsset`
  → `loadModel`), which is slow. So mobile's model choice is a **global setting**, lives in the
  **Brain → Models** panel (where reloads are already expected), not a composer dropdown.
- `@qvac/sdk` has **no `listModels()` for chat models** — the catalog is TS constants
  (`QWEN3_600M_INST_Q4`, `QWEN3_1_7B_INST_Q4`, `QWEN3_4B_INST_Q4_K_M`, `LLAMA_3_2_1B_INST_Q4_0`, …);
  we curate a phone-runnable subset.
- `completion({ modelId })` takes the id per-call but the model must already be `loadModel`-ed;
  only one chat model is loaded at a time, so switching = unload old + load new.

## Decisions (locked)

1. **Model selection only; no agent picker** (any platform). Leash orchestration unchanged.
2. **Global choice, not per-conversation** (platform-forced by the local reload cost).
3. **Home is Brain → Models** (`ModelsPanel.tsx`), reusing its existing model-state UI.
4. **Curated chat-model set** (phone-runnable): Qwen3 600M, Qwen3 1.7B (default), Qwen3 4B,
   Llama-3.2-1B. Exclude 8B / MoE (too large for a phone).
5. **Failure-safe switching:** a failed download/load keeps the current model loaded; never leaves
   the app with no chat model.
6. **Mesh/voice/STT/TTS untouched.** When mesh delegation is on, `delegatedIdRef` still wins per the
   existing logic; the local model choice is what the on-device path uses.

## Architecture

```
apps/mobile/modelsInventory.ts   ── add CHAT_MODELS (curated text models) to the MODELS catalog
apps/mobile/selectedModel.ts     ── NEW: persist the chosen chat-model key (expo-file-system JSON)
apps/mobile/App.tsx
  mount: key = getSelectedChatKey() ?? default → load THAT entry (was: hardcoded constant)
  selectChatModel(key): guard-if-generating → unloadModel(old) → downloadAsset(new, onProgress)
                        → loadModel(new) → modelIdRef/setModelId + dynamic label → setSelectedChatKey
apps/mobile/brain/ModelsPanel.tsx ── chat-model selector: list CHAT_MODELS + state + "Use" action
```

### Component 1 — Chat-model catalog (`apps/mobile/modelsInventory.ts`)

Add a curated `CHAT_MODELS: ModelEntry[]` (or extend `MODELS`) — each `kind:"text"`, a stable
`key` (`chat-qwen3-0.6b`, `chat-qwen3-1.7b`, `chat-qwen3-4b`, `chat-llama-1b`), `label`, `assetSrc`
(the `@qvac/sdk` constant), and `name`. The existing `probeModel`/`listModels` already return
`state: "loaded" | "cached" | "not-downloaded"` + `sizeBytes` for each. The current default entry
(`chat-qwen3-1.7b`) keeps its existing key so a fresh install behaves exactly as today.

### Component 2 — Selection persistence (`apps/mobile/selectedModel.ts`, NEW)

Mirror `prompts.ts` exactly (expo-file-system `documentDirectory` + JSON, best-effort, try/catch):
- `getSelectedChatKey(): Promise<string>` → the stored key, or the default `"chat-qwen3-1.7b"`.
- `setSelectedChatKey(key: string): Promise<void>` → write `{ chatKey }`.
Never throws; a corrupt/missing file falls back to the default.

### Component 3 — Mount + switch flow (`apps/mobile/App.tsx`)

- **Mount:** replace the hardcoded `QWEN3_1_7B_INST_Q4` download+load (~lines 248–303) with: read
  `getSelectedChatKey()`, resolve the catalog entry (fallback to the default entry if the key is
  unknown), then `downloadAsset` + `loadModel` that entry. Store its label for the masthead.
- **`selectChatModel(key)`** (new): if a generation is in flight, refuse (surface "finish the current
  reply first"); else unload the current chat model, `downloadAsset` the new (with progress shown),
  `loadModel` it, update `modelIdRef.current`/`setModelId` + the dynamic model label, and
  `setSelectedChatKey(key)`. On any failure, reload/keep the previous model and surface the error —
  the app is never left without a chat model.
- The masthead model label (today the constant `MODEL_LABEL`) becomes state driven by the active
  entry's label.

### Component 4 — Models panel UI (`apps/mobile/brain/ModelsPanel.tsx`)

Add a chat-model section above/alongside the existing STT/TTS rows: list `CHAT_MODELS` with each
one's state (loaded / cached / not-downloaded) and size, the active one marked (a check / "current"),
and a **Use** action that calls `selectChatModel(key)` (passed in from `App.tsx`, like the existing
load/unload handlers). Disable the action while a switch or a generation is in progress. Reuse the
panel's existing row styling — no new design system.

## Data flow

1. App launch → `getSelectedChatKey()` → load that chat model → masthead shows its label.
2. User opens Brain → Models → taps **Use** on another chat model → `selectChatModel` unloads the
   old, downloads (if needed, with progress), loads the new, persists the key, updates the label.
3. Next `runCompletion` reads `modelIdRef.current` (already updated) — the new model answers.
4. Restart → the persisted key loads the same model.

## Error handling

- `selectedModel.ts` never throws; missing/corrupt ⇒ default key.
- Switch failure (download/load) ⇒ keep/reload the previous model, show the error, do not persist
  the failed key.
- Mid-generation switch ⇒ refused with a message.
- Offline + chosen model not cached ⇒ the download fails gracefully (kept on the old model); a model
  already cached loads offline fine.

## Testing

- **No RN test harness** — verification is **manual on-device** (the user): pick each model →
  confirm download/load, that chat uses it, persistence across restart, offline-with-cached load,
  and that a mid-generation switch is refused.
- **Static:** `apps/mobile` TypeScript typecheck passes (no new type errors); the curated
  `@qvac/sdk` model constants resolve (import-checks).

## Scope boundaries (YAGNI)

- No agent picker, anywhere. Leash orchestration unchanged.
- Model choice is global, not per-conversation (platform-forced).
- No web/desktop changes (already consistent).
- No changes to mesh delegation, voice, STT, or TTS.
- No new model-management infrastructure beyond the curated catalog + one persistence file + the
  switch flow + the panel section.

## Build order

1. Add `CHAT_MODELS` to `modelsInventory.ts` (curated, phone-runnable).
2. `selectedModel.ts` persistence (mirror `prompts.ts`).
3. `App.tsx`: mount loads the saved key; add `selectChatModel` switch flow + dynamic label.
4. `ModelsPanel.tsx`: chat-model selector section wired to `selectChatModel`.
5. Typecheck + manual on-device verification.
