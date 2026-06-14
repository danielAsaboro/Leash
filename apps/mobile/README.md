# @mycelium/mobile — Leash iOS/Android (Expo)

A fully **on-device** LLM chat. `@qvac/sdk` runs inference natively on the phone via its Expo
integration — no server, no `qvac serve` subprocess, offline after the first model download.

This is an **isolated** Expo project: it has its **own `node_modules`** and is **excluded from the
root npm workspace** (so its React Native / Expo install can't destabilize the web + desktop apps).
Run all commands from `apps/mobile/`.

## Requirements

- A **physical device** (iPhone/Android). llamacpp does **not** run on the iOS simulator / Android
  emulator — `expo run:ios --device` / `expo run:android --device` only.
- Xcode + CocoaPods (iOS) / Android Studio (Android), and an Apple signing identity for device builds.
- Expo SDK 54, React Native 0.81, React 19.1.

## Build & run (iOS)

```bash
cd apps/mobile
npm install                                              # isolated install (own node_modules)
npx expo install expo-file-system expo-build-properties expo-device
npx expo prebuild --platform ios                        # generates ios/ (Xcode project + Pods)
npx expo run:ios --device                                # build + install on a plugged-in iPhone
```

First launch downloads the model (`LLAMA_3_2_1B_INST_Q4_0`, ~0.7 GB) from the QVAC registry/peers,
loads it on the GPU, then streams replies token-by-token. Watch the terminal for download progress.

## Notes

- The QVAC Expo plugin (`@qvac/sdk/expo-plugin`) + `expo-build-properties` are wired in `app.json`;
  `expo prebuild` applies them to the native project (bare worker bundle, device info, NDK/arch).
- `ios/` and `android/` are git-ignored (Continuous Native Generation) — regenerate with `expo prebuild`.
- Bundle id: `com.mycelium.leash`.
