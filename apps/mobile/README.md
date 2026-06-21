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

## Build & run (Android)

```bash
cd apps/mobile
npm install                                              # isolated install (own node_modules)
npx expo prebuild --platform android                    # generates android/ + QVAC worker bundle
npm run android:release                                 # build, install, and launch on a USB device
```

The release variant embeds the JavaScript bundle, so it launches without Metro and is the correct
build for offline testing. Android builds require Java 17, Android SDK platform/build tools, and the
NDK version pinned by the installed `@qvac/sdk` Expo plugin.

Android uses the official extracted `@react-native-community/javascriptcore` runtime. The local
`plugins/with-android-jsc.js` config plugin enables `useThirdPartyJSC` and injects the JSC executor
and runtime factories into generated `MainApplication.kt`. This is required because Expo SDK 54's
default Android New Architecture host constructs Hermes directly even when `jsEngine` is `jsc`,
causing a release launch crash (`couldn't find DSO to load: libhermestooling.so`). Do not remove the
plugin or switch Android to Hermes until the QVAC worker bundle has been verified there.

First launch downloads the model (`LLAMA_3_2_1B_INST_Q4_0`, ~0.7 GB) from the QVAC registry/peers,
loads it on the GPU, then streams replies token-by-token. Watch the terminal for download progress.

## Notes

- The QVAC Expo plugin (`@qvac/sdk/expo-plugin`) + `expo-build-properties` are wired in `app.json`;
  `expo prebuild` applies them to the native project (Bare worker bundle, device info, NDK/arch).
- `ios/` and `android/` are git-ignored (Continuous Native Generation) — regenerate with `expo prebuild`.
- Bundle id: `com.mycelium.leash`.
