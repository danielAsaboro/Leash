#!/usr/bin/env bash
# Build a self-contained, arch-pruned QVAC runtime for the packaged desktop app, so the qvac serve
# (and the bundled daemons) run via Electron's own Node — NO system Node, NO `npx` download.
#
# The engine packages ship prebuilds for every platform (~3.7 GB total); we keep only the host
# Mac's arch (darwin-arm64 → ~166 MB). Output: apps/desktop/qvac-runtime/ (git-ignored, shipped
# via electron-builder extraResources). Re-run when @qvac/cli or @qvac/sdk changes.
set -euo pipefail

CLI_VER="${QVAC_CLI_VERSION:-0.6.0}"
SDK_VER="${QVAC_SDK_VERSION:-0.12.1}"
PROVIDER_VER="${QVAC_PROVIDER_VERSION:-0.1.0}"   # @qvac/ai-sdk-provider — the model catalog (allModels) source
ARCH_KEEP="${QVAC_PREBUILD_ARCH:-darwin-arm64}"

here="$(cd "$(dirname "$0")/.." && pwd)"   # apps/desktop
out="$here/qvac-runtime"

echo "[qvac-runtime] building @qvac/cli@$CLI_VER (+ sdk@$SDK_VER, tsx) → $out (keep $ARCH_KEEP)"
rm -rf "$out"
mkdir -p "$out"
cat > "$out/package.json" <<JSON
{ "name": "qvac-runtime", "private": true, "version": "0.0.0",
  "dependencies": { "@qvac/cli": "$CLI_VER", "@qvac/sdk": "$SDK_VER", "@qvac/ai-sdk-provider": "$PROVIDER_VER", "tsx": "^4.19.2" } }
JSON

# Prefer the local npm cache (the root install already populated it); fall back to the network.
( cd "$out" && npm install --no-audit --no-fund --prefer-offline --omit=dev 2>&1 | tail -3 )

echo "[qvac-runtime] pruning prebuilds to $ARCH_KEEP …"
# Each engine has node_modules/@qvac/<eng>/prebuilds/<platform>/… — delete every platform but ours.
find "$out/node_modules" -type d -name prebuilds 2>/dev/null | while read -r pb; do
  for plat in "$pb"/*/; do
    [ "$(basename "$plat")" = "$ARCH_KEEP" ] || rm -rf "$plat"
  done
done

echo "[qvac-runtime] dropping React Native / Expo deps (mobile-only; the Node serve never uses them) …"
( cd "$out/node_modules" && rm -rf \
    react-native-bare-kit react-native react-dom hermes-compiler metro metro-* \
    @react-native @react-native-community @expo expo expo-* @react-navigation 2>/dev/null || true )

echo "[qvac-runtime] done — size: $(du -sh "$out" | awk '{print $1}')"
echo "[qvac-runtime] cli entry: $(ls "$out/node_modules/@qvac/cli/dist/index.js" 2>/dev/null && echo ok || echo MISSING)"
echo "[qvac-runtime] provider:  $([ -d "$out/node_modules/@qvac/ai-sdk-provider" ] && echo ok || echo MISSING) (needed for the on-device model catalog)"
