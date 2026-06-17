# Phase D: Mobile Model Selection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the mobile (RN/Expo/JSC) user change the chat model from a curated on-device set, persisted across restarts — matching web/desktop's "you can only change the model." No agent picker.

**Architecture:** Add a curated `CHAT_MODELS` catalog to `apps/mobile/modelsInventory.ts`; persist the chosen key in a new `apps/mobile/selectedModel.ts` (expo-file-system, mirroring `prompts.ts`); make `App.tsx` load the saved model at mount and add a failure-safe `selectChatModel(key)` switch flow (unload→download→load→persist) with a dynamic masthead label; add a chat-model selector section to `ModelsPanel.tsx`, threading the handler from `App.tsx` through `BrainScreen`.

**Tech Stack:** React Native / Expo (JSC), `@qvac/sdk` (`loadModel`/`unloadModel`/`downloadAsset`/`getModelInfo` + model constants), `expo-file-system/legacy`, TypeScript.

## Global Constraints

- **No agent picker, any platform.** This is MODEL selection only; Leash orchestration is unchanged.
- **Global choice, not per-conversation** (platform-forced: mobile reloads weights locally). One active chat model at a time.
- **Curated phone-runnable set ONLY:** `QWEN3_600M_INST_Q4`, `QWEN3_1_7B_INST_Q4` (default), `QWEN3_4B_INST_Q4_K_M`, `LLAMA_3_2_1B_INST_Q4_0`. These exact `@qvac/sdk` constant names are verified to exist. Do NOT add 8B/MoE/multimodal — too large for a phone.
- **Failure-safe:** a failed download/load must keep/restore the previously-loaded chat model — never leave the app with no chat model.
- **Default unchanged for fresh installs:** the default selection is `qwen3-1.7b` (today's hardcoded model), so a fresh install behaves exactly as now.
- **Don't touch** mesh delegation (`delegatedIdRef` still wins when mesh is on), voice, STT, or TTS.
- **No RN test harness** — per-task verification is the mobile **TypeScript typecheck** (`npx tsc -p apps/mobile --noEmit`, only pre-existing errors allowed); behavioral verification is **manual on-device** (Task 4).
- **Branch:** `feat/mobile-model-selection` (already created; spec is its first commit). One commit per task.
- **Never run `npm install` in the background** (hard repo rule).

---

### Task 1: Chat-model catalog + selection persistence

**Files:**
- Modify: `apps/mobile/modelsInventory.ts` (add `CHAT_MODELS` + `ChatModelEntry` + `listChatModels`)
- Create: `apps/mobile/selectedModel.ts`

**Interfaces:**
- Consumes: `@qvac/sdk` model constants; existing `getModelInfo`/`downloadAsset` + `ModelState`/`probeModel` helpers in `modelsInventory.ts`.
- Produces: `CHAT_MODELS: ChatModelEntry[]`, `type ChatModelEntry`, `listChatModels(): Promise<ChatModelStatus[]>`, `DEFAULT_CHAT_KEY`; and `getSelectedChatKey()`/`setSelectedChatKey(key)` (selectedModel.ts).

- [ ] **Step 1: Establish the typecheck baseline**

Run: `cd /Volumes/Development/qvac/mycelium && npx tsc -p apps/mobile --noEmit 2>&1 | grep "error TS" | sort | uniq | tee /tmp/mobile-tsc-baseline.txt; wc -l < /tmp/mobile-tsc-baseline.txt`
Record the count + list — this is the set of PRE-EXISTING errors. Every later typecheck must show only these.
(If `apps/mobile` has no `tsconfig.json`, use the command the app uses — check `apps/mobile/package.json` "scripts" for a `typecheck`/`tsc` script and use that; record its baseline output.)

- [ ] **Step 2: Add the curated chat-model catalog to `modelsInventory.ts`**

Add to the `@qvac/sdk` import (alongside `QWEN3_1_7B_INST_Q4`): `QWEN3_600M_INST_Q4, QWEN3_4B_INST_Q4_K_M, LLAMA_3_2_1B_INST_Q4_0`. Then add below the existing `MODELS` array:

```typescript
/** A selectable on-device chat model (the user picks one; only one is loaded at a time). */
export type ChatModelEntry = {
  /** Stable key persisted as the user's choice. */
  chatKey: string;
  alias: string;
  label: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assetSrc: any;
  name: string;
};

/** Curated phone-runnable chat models. Default (qwen3-1.7b) keeps today's behavior on a fresh install. */
export const CHAT_MODELS: ChatModelEntry[] = [
  { chatKey: "qwen3-0.6b", alias: "qwen3-0.6b", label: "Qwen3 · 0.6B", assetSrc: QWEN3_600M_INST_Q4, name: (QWEN3_600M_INST_Q4 as any).name },
  { chatKey: "qwen3-1.7b", alias: "qwen3-1.7b", label: "Qwen3 · 1.7B", assetSrc: QWEN3_1_7B_INST_Q4, name: (QWEN3_1_7B_INST_Q4 as any).name },
  { chatKey: "qwen3-4b", alias: "qwen3-4b", label: "Qwen3 · 4B", assetSrc: QWEN3_4B_INST_Q4_K_M, name: (QWEN3_4B_INST_Q4_K_M as any).name },
  { chatKey: "llama-1b", alias: "llama-3.2-1b", label: "Llama 3.2 · 1B", assetSrc: LLAMA_3_2_1B_INST_Q4_0, name: (LLAMA_3_2_1B_INST_Q4_0 as any).name },
];

export const DEFAULT_CHAT_KEY = "qwen3-1.7b";

/** Resolve a chat-model entry by key, falling back to the default (never undefined). */
export function chatEntry(key: string | null | undefined): ChatModelEntry {
  return CHAT_MODELS.find((m) => m.chatKey === key) ?? CHAT_MODELS.find((m) => m.chatKey === DEFAULT_CHAT_KEY)!;
}

export type ChatModelStatus = ChatModelEntry & { state: ModelState; sizeBytes: number | null };

/** Probe each chat model's live state (loaded/cached/not-downloaded), reusing the SDK getModelInfo path. */
export async function listChatModels(): Promise<ChatModelStatus[]> {
  return Promise.all(
    CHAT_MODELS.map(async (entry): Promise<ChatModelStatus> => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const info: any = await getModelInfo({ name: entry.name } as any);
        const state: ModelState = info?.isLoaded ? "loaded" : info?.isCached ? "cached" : "not-downloaded";
        return { ...entry, state, sizeBytes: info?.actualSize ?? info?.expectedSize ?? null };
      } catch {
        return { ...entry, state: "unknown", sizeBytes: null };
      }
    }),
  );
}
```

- [ ] **Step 3: Create `apps/mobile/selectedModel.ts`**

Mirror `apps/mobile/prompts.ts` (read it first to match its exact import + style):

```typescript
/**
 * Persists the user's chosen chat model (its `chatKey`) — the phone analogue of the web's
 * per-conversation model picker, but GLOBAL (mobile reloads weights locally, so one active model).
 * Best-effort JSON in the app's document directory; a missing/corrupt file falls back to the default.
 */
import * as FileSystem from "expo-file-system/legacy";
import { DEFAULT_CHAT_KEY } from "./modelsInventory";

const FILE = `${FileSystem.documentDirectory}selectedModel.json`;

export async function getSelectedChatKey(): Promise<string> {
  try {
    const info = await FileSystem.getInfoAsync(FILE);
    if (!info.exists) return DEFAULT_CHAT_KEY;
    const data = JSON.parse(await FileSystem.readAsStringAsync(FILE)) as { chatKey?: string };
    return typeof data.chatKey === "string" && data.chatKey ? data.chatKey : DEFAULT_CHAT_KEY;
  } catch {
    return DEFAULT_CHAT_KEY;
  }
}

export async function setSelectedChatKey(chatKey: string): Promise<void> {
  try {
    await FileSystem.writeAsStringAsync(FILE, JSON.stringify({ chatKey }));
  } catch {
    /* best-effort */
  }
}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc -p apps/mobile --noEmit 2>&1 | grep "error TS" | sort | uniq`
Expected: identical to the Step 1 baseline (no NEW errors). If `expo-file-system/legacy` or a model constant fails to resolve, fix the import to match what `prompts.ts`/`modelsInventory.ts` already use successfully.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/modelsInventory.ts apps/mobile/selectedModel.ts
git commit -m "feat(mobile): curated chat-model catalog + selected-model persistence"
```

---

### Task 2: Load saved model at mount + failure-safe switch flow

**Files:**
- Modify: `apps/mobile/App.tsx` (mount load, `selectChatModel`, dynamic model label)

**Interfaces:**
- Consumes: `CHAT_MODELS`/`chatEntry`/`DEFAULT_CHAT_KEY` (Task 1), `getSelectedChatKey`/`setSelectedChatKey` (Task 1), existing `loadModel`/`unloadModel`/`downloadAsset` from `@qvac/sdk`, existing `modelIdRef`/`setModelId`/`busy`-or-generating state.
- Produces: `selectChatModel(chatKey: string): Promise<void>` and a stateful model label, both passed to the Brain screen in Task 3.

- [ ] **Step 1: Read `App.tsx` to confirm the anchors**

Read `apps/mobile/App.tsx`. Locate: the `@qvac/sdk` import line with `QWEN3_1_7B_INST_Q4`/`loadModel` (and add `unloadModel` if absent); `const MODEL_LABEL = "Qwen3 · 1.7B"`; `modelIdRef` (useRef); the mount `useEffect` that calls `downloadAsset(QWEN3_1_7B_INST_Q4)` + `loadModel({ modelSrc: QWEN3_1_7B_INST_Q4, ... })` + `modelIdRef.current = id` + `setModelId(id)`; the flag that indicates a generation is in flight (e.g. a `busy`/`generating`/streaming ref or state used to disable the input); and where `MODEL_LABEL` is rendered in the masthead.

- [ ] **Step 2: Add imports + a dynamic label state**

In `App.tsx`:
- Extend the `@qvac/sdk` import to include `unloadModel` (keep the existing constants).
- Import the catalog + persistence:
  ```typescript
  import { CHAT_MODELS, chatEntry, DEFAULT_CHAT_KEY } from "./modelsInventory";
  import { getSelectedChatKey, setSelectedChatKey } from "./selectedModel";
  ```
- Replace the `const MODEL_LABEL = "Qwen3 · 1.7B"` usage with state: add near the other `useState`s:
  ```typescript
  const [chatKey, setChatKey] = useState<string>(DEFAULT_CHAT_KEY);
  const modelLabel = chatEntry(chatKey).label;
  ```
  and render `{modelLabel}` wherever `MODEL_LABEL` was shown. (If `MODEL_LABEL` is referenced in multiple places, replace each; remove the now-unused constant.)

- [ ] **Step 3: Load the SAVED model at mount**

In the mount `useEffect`, replace the hardcoded `QWEN3_1_7B_INST_Q4` download+load with the saved entry. Concretely, before the download, resolve the entry; use it for both `downloadAsset` and `loadModel`:
```typescript
  const savedKey = await getSelectedChatKey();
  const entry = chatEntry(savedKey);
  setChatKey(entry.chatKey);
  // ...existing progress setup...
  await downloadAsset({ assetSrc: entry.assetSrc, /* ...existing onProgress... */ });
  const id = await loadModel({ modelSrc: entry.assetSrc, /* ...existing modelType/modelConfig... */ });
  modelIdRef.current = id;
  setModelId(id);
```
Keep every other option (`modelType`, `modelConfig`, progress callbacks, error handling) exactly as the existing code has it — only the `assetSrc`/`modelSrc` source changes from the constant to `entry.assetSrc`.

- [ ] **Step 4: Add the failure-safe `selectChatModel` switch flow**

Add a `useCallback` (near `runCompletion`):
```typescript
  const switchingRef = useRef(false);
  const selectChatModel = useCallback(async (key: string): Promise<void> => {
    if (switchingRef.current) return;
    // Refuse mid-generation (replace `generatingRef.current` with the actual in-flight flag found in Step 1).
    if (generatingRef.current) { Alert.alert("Busy", "Finish the current reply before switching models."); return; }
    const target = chatEntry(key);
    if (target.chatKey === chatKey) return;
    switchingRef.current = true;
    const prev = chatEntry(chatKey);
    const prevId = modelIdRef.current;
    try {
      if (prevId) { try { await unloadModel({ modelId: prevId, clearStorage: false }); } catch { /* continue */ } }
      modelIdRef.current = null;
      setModelId(null);
      await downloadAsset({ assetSrc: target.assetSrc /* + the same onProgress used at mount, if wired */ });
      const id = await loadModel({ modelSrc: target.assetSrc /* + the SAME modelType/modelConfig used at mount */ });
      modelIdRef.current = id;
      setModelId(id);
      setChatKey(target.chatKey);
      await setSelectedChatKey(target.chatKey);
    } catch (e) {
      // Failure-safe: restore the previous model so the app is never left without a chat model.
      try {
        await downloadAsset({ assetSrc: prev.assetSrc });
        const id = await loadModel({ modelSrc: prev.assetSrc /* same config */ });
        modelIdRef.current = id;
        setModelId(id);
        setChatKey(prev.chatKey);
      } catch { /* leave refs null; mount-style recovery on next launch */ }
      Alert.alert("Couldn't switch model", e instanceof Error ? e.message : String(e));
    } finally {
      switchingRef.current = false;
    }
  }, [chatKey]);
```
- Use the SAME `loadModel` config object the mount uses (extract it to a small local `const LLM_CONFIG = { modelType: "llm", modelConfig: { device: "gpu", ctx_size: 4096, ... } }` shared by mount + switch to avoid drift — match the existing values exactly).
- `generatingRef`/`Alert` — wire to the app's actual in-flight indicator and import `Alert` from `react-native` if not already imported. If there is no ref for "is generating," use the existing state that disables the composer (Step 1 identifies it).

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p apps/mobile --noEmit 2>&1 | grep "error TS" | sort | uniq`
Expected: only the Task 1 baseline errors. Fix any new error (e.g. a missing `unloadModel`/`Alert` import, or a `modelConfig` shape mismatch — match the mount's existing call exactly).

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/App.tsx
git commit -m "feat(mobile): load saved chat model at mount + failure-safe model switch"
```

---

### Task 3: Chat-model selector in the Models panel

**Files:**
- Modify: `apps/mobile/brain/ModelsPanel.tsx` (chat-model selector section + props)
- Modify: `apps/mobile/App.tsx` and `apps/mobile/BrainScreen.tsx` (thread `selectChatModel` + `chatKey` to the panel)

**Interfaces:**
- Consumes: `selectChatModel(key)` + `chatKey` (Task 2), `listChatModels`/`ChatModelStatus`/`fmtBytes`/`stateLabel` (Task 1 / existing).
- Produces: a chat-model selection UI in Brain → Models.

- [ ] **Step 1: Read `BrainScreen.tsx` + how `ModelsPanel` is mounted**

Read `apps/mobile/BrainScreen.tsx` to see how it renders `<ModelsPanel />` (it currently takes no props) and how `App.tsx` renders `<BrainScreen .../>`. Determine the prop path App → BrainScreen → ModelsPanel.

- [ ] **Step 2: Thread the props**

- `App.tsx`: pass `selectChatModel` and `chatKey` into `<BrainScreen ... />` (add props to the existing render).
- `BrainScreen.tsx`: accept `selectChatModel: (key: string) => Promise<void>` and `chatKey: string` in its props type and forward them to `<ModelsPanel selectChatModel={selectChatModel} currentChatKey={chatKey} />`.

- [ ] **Step 3: Add the chat-model selector to `ModelsPanel.tsx`**

- Change the signature: `export function ModelsPanel({ selectChatModel, currentChatKey }: { selectChatModel: (key: string) => Promise<void>; currentChatKey: string })`.
- Add chat-model state + load: `const [chats, setChats] = useState<ChatModelStatus[] | null>(null);` and in the existing `refresh`, also `void listChatModels().then(setChats);`. Import `listChatModels, type ChatModelStatus` from `../modelsInventory`.
- Render a "Chat model" section ABOVE the existing `models.map(...)` rows (which stay for STT/TTS — filter the existing `models` render to `m.key !== "chat"` so the old single "chat" row is replaced by this richer selector). Each chat row shows label, alias, state (reuse `stateColor`/`stateLabel`/`fmtBytes`), the active one marked, and a **Use** action when it isn't current:
```tsx
{chats?.map((m) => {
  const isCurrent = m.chatKey === currentChatKey;
  const isBusy = busy === m.chatKey;
  const p = pct[m.chatKey];
  return (
    <View key={m.chatKey} style={styles.row}>
      <View style={styles.rowTop}>
        <View style={{ flex: 1 }}>
          <Text style={styles.name}>{m.label}{isCurrent ? "  ·  current" : ""}</Text>
          <Text style={styles.role}>Chat · {m.alias}</Text>
        </View>
        <View style={styles.badge}>
          <View style={[styles.dot, { backgroundColor: stateColor(m.state) }]} />
          <Text style={[styles.badgeText, { color: stateColor(m.state) }]}>{isBusy && p != null ? `${p}%` : stateLabel(m.state)}</Text>
        </View>
      </View>
      <View style={styles.rowBottom}>
        <Text style={styles.size}>{fmtBytes(m.sizeBytes)}</Text>
        <View style={{ flex: 1 }} />
        {isBusy ? <ActivityIndicator size="small" color={C.sage} /> : !isCurrent ? (
          <Pressable onPress={() => { setBusy(m.chatKey); void selectChatModel(m.chatKey).finally(() => { setBusy(null); refresh(); }); }} hitSlop={6} style={styles.actionBtn}>
            <Text style={styles.action}>USE</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
})}
```
- Filter the existing STT/TTS render: change `{models.map((m) => {` to operate on `models.filter((m) => m.key !== "chat")` so the legacy single chat row no longer renders (the selector replaces it).

- [ ] **Step 4: Typecheck**

Run: `npx tsc -p apps/mobile --noEmit 2>&1 | grep "error TS" | sort | uniq`
Expected: only the Task 1 baseline. Fix any new error (most likely a missing prop on a `<ModelsPanel/>` or `<BrainScreen/>` call site — there should be exactly one each).

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/brain/ModelsPanel.tsx apps/mobile/BrainScreen.tsx apps/mobile/App.tsx
git commit -m "feat(mobile): chat-model selector in Brain → Models (Use to switch)"
```

---

### Task 4: Typecheck + manual on-device verification

**Files:** none (verification only).

- [ ] **Step 1: Full mobile typecheck**

Run: `cd /Volumes/Development/qvac/mycelium && npx tsc -p apps/mobile --noEmit 2>&1 | grep "error TS" | sort | uniq`
Expected: identical to the Task 1 baseline (zero new errors).

- [ ] **Step 2: Manual on-device e2e (the user runs this — needs a physical device)**

Document the steps to verify (and note that the iOS build recipe is in the project memory `mobile-jsc-not-hermes`):
- Fresh launch loads `qwen3-1.7b` (unchanged default); chat works.
- Brain → Models shows the four chat models with state (LOADED/READY/NOT DOWNLOADED) + sizes; the current one marked.
- Tapping **Use** on another model unloads the old, downloads (progress %) if needed, loads the new; the masthead label updates; a chat message is answered by the new model.
- Force-quit + relaunch → the chosen model loads (persisted).
- Airplane mode + a model already cached → **Use** loads it offline; an un-cached model → graceful "couldn't switch" + the previous model still works.
- Tapping **Use** mid-reply is refused with the "finish the current reply" alert.
- Mesh on (if set up) still delegates as before (model choice doesn't break delegation).

- [ ] **Step 3: Commit (if verification needed fixes)**

```bash
git add -A && git commit -m "fix(mobile): model-selection verification fixes" || echo "nothing to commit"
```

---

## Verification (summary)

- **Static:** `apps/mobile` typecheck shows only the pre-existing baseline errors after every task.
- **Manual on-device:** default unchanged; the four curated models are selectable with live state; switching unloads→downloads→loads and persists; failure-safe (a bad switch keeps the old model); mid-generation switch refused; mesh/voice untouched.
