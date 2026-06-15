#!/usr/bin/env bash
# Build a self-contained, arch-pruned QVAC runtime for the packaged desktop app, so the qvac serve
# (and the bundled daemons) run via Electron's own Node — NO system Node, NO `npx` download.
#
# The engine packages ship prebuilds for every platform (~3.7 GB total); we keep only the host
# Mac's arch (darwin-arm64 → ~166 MB). Output: apps/desktop/qvac-runtime/ (git-ignored, shipped
# via electron-builder extraResources). Re-run when @qvac/cli or @qvac/sdk changes.
set -euo pipefail

CLI_VER="${QVAC_CLI_VERSION:-0.6.0}"
# @qvac/cli@0.6.0 pins @qvac/sdk ^0.12.0, but we run the whole runtime coherently on SDK_VER via an
# npm `override` below (forces the cli's nested SDK + engines to the same version — no split). 0.13.1
# is the floor that fixes vision (0.12.1 tokenizes the image then 500s); matches the app side.
SDK_VER="${QVAC_SDK_VERSION:-0.13.1}"
PROVIDER_VER="${QVAC_PROVIDER_VERSION:-0.2.1}"   # @qvac/ai-sdk-provider — the model catalog (allModels) source
ARCH_KEEP="${QVAC_PREBUILD_ARCH:-darwin-arm64}"

here="$(cd "$(dirname "$0")/.." && pwd)"   # apps/desktop
out="$here/qvac-runtime"

echo "[qvac-runtime] building @qvac/cli@$CLI_VER (+ sdk@$SDK_VER, tsx) → $out (keep $ARCH_KEEP)"
rm -rf "$out"
mkdir -p "$out"
cat > "$out/package.json" <<JSON
{ "name": "qvac-runtime", "private": true, "version": "0.0.0",
  "dependencies": { "@qvac/cli": "$CLI_VER", "@qvac/sdk": "$SDK_VER", "@qvac/ai-sdk-provider": "$PROVIDER_VER", "tsx": "^4.19.2" },
  "overrides": { "@qvac/sdk": "$SDK_VER" } }
JSON

# Prefer the local npm cache (the root install already populated it); fall back to the network.
( cd "$out" && npm install --no-audit --no-fund --prefer-offline --omit=dev 2>&1 | tail -3 )

# Apply the leash @qvac/cli vision patch (OpenAI `image_url` content → SDK `attachments`) so the
# PACKAGED serve does multimodal vision (screenshot description, image-in-chat). In dev this lands via
# patch-package's postinstall; the runtime is a SEPARATE install patch-package never sees, so apply it
# here against the bundled cli. Version-matched to @qvac/cli 0.6.0; --forward no-ops if already applied.
repo="$(cd "$here/../.." && pwd)"
cli_patch="$repo/patches/@qvac+cli+$CLI_VER.patch"
if [ -f "$cli_patch" ] && [ -d "$out/node_modules/@qvac/cli" ]; then
  if ( cd "$out" && patch -p1 --forward --silent < "$cli_patch" ); then
    echo "[qvac-runtime] ✓ applied @qvac/cli vision patch (image_url → attachments)"
  else
    echo "[qvac-runtime] ⚠️  @qvac/cli vision patch did NOT apply — packaged vision will be off" >&2
  fi
else
  echo "[qvac-runtime] ⚠️  cli patch ($cli_patch) or bundled cli missing — packaged vision unpatched" >&2
fi

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
