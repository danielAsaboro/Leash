#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────────────────────────
# Repeatable build + release for the Leash desktop app. ONE command after any change.
#
#   scripts/release.sh                      # code change → rebuild web + DMG only (no dep re-upload)
#   scripts/release.sh --daemons            # daemon/@mycelium change → rebuild+upload daemons overlay, then DMG
#   scripts/release.sh --runtime            # @qvac/cli|sdk|provider bump → rebuild+upload base runtime, then DMG
#   scripts/release.sh --runtime --daemons  # both deps
#   scripts/release.sh --daemons --no-dmg   # just refresh the daemons release asset
#
# What it does, in order (only the parts you ask for):
#   1. (--runtime)  build-qvac-runtime.sh  → pack → UPLOAD to the GitHub release → update manifest.runtime sha
#   2. (--daemons)  build-leash-daemons.sh → pack → UPLOAD to the GitHub release → update manifest.daemons sha
#   3. always       web `next build` (stages scripts/launcher) → electron-vite + electron-builder
#   4. always       deep ad-hoc re-sign the .app (fixes the after-pack seal) → repackage the DMG
#
# The release repo/tag are read from deps-manifest.json `baseUrl`. The GitHub token comes from the
# macOS keychain (git's osxkeychain helper) — no `gh` CLI needed. Deps NOT rebuilt are left untouched
# on the release (and their manifest sha preserved) — never re-pack a tarball you didn't change
# (tar isn't deterministic → a needless sha change → a needless re-upload).
# ─────────────────────────────────────────────────────────────────────────────────────────────────
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"   # apps/desktop
manifest="$here/src/main/deps-manifest.json"
distdeps="$here/dist-deps"
arch="${QVAC_PREBUILD_ARCH:-darwin-arm64}"

DO_RUNTIME=0; DO_DAEMONS=0; DO_DMG=1
for a in "$@"; do case "$a" in
  --runtime) DO_RUNTIME=1 ;;
  --daemons) DO_DAEMONS=1 ;;
  --no-dmg)  DO_DMG=0 ;;
  --help|-h) sed -n '2,20p' "$0"; exit 0 ;;
  *) echo "unknown flag: $a (see --help)" >&2; exit 2 ;;
esac; done

# ── GitHub release coordinates (from the manifest baseUrl) + token (from keychain) ──────────────
base_url="$(node -e "console.log(require('$manifest').baseUrl)")"
OWNER="$(echo "$base_url" | sed -E 's#https://github.com/([^/]+)/([^/]+)/releases/download/(.+)#\1#')"
REPO="$(echo  "$base_url" | sed -E 's#https://github.com/([^/]+)/([^/]+)/releases/download/(.+)#\2#')"
TAG="$(echo   "$base_url" | sed -E 's#https://github.com/([^/]+)/([^/]+)/releases/download/(.+)#\3#')"
need_upload=$(( DO_RUNTIME + DO_DAEMONS ))

gh_token() { printf "protocol=https\nhost=github.com\n\n" | git credential-osxkeychain get 2>/dev/null | awk -F= '/^password=/{print $2}'; }
if [ "$need_upload" -gt 0 ]; then
  TOKEN="$(gh_token)"; [ -n "$TOKEN" ] || { echo "✗ no GitHub token in keychain (git credential-osxkeychain)" >&2; exit 1; }
  RID="$(curl -sS -H "Authorization: token $TOKEN" "https://api.github.com/repos/$OWNER/$REPO/releases/tags/$TAG" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);if(!r.id){console.error('release '+'$TAG'+' not found on '+'$OWNER/$REPO');process.exit(1)}console.log(r.id)})")"
  echo "[release] target: $OWNER/$REPO @ $TAG (release id $RID)"
fi

del_asset() {  # del_asset <name>  — remove any same-named asset (so re-upload doesn't 422)
  curl -sS -H "Authorization: token $TOKEN" "https://api.github.com/repos/$OWNER/$REPO/releases/$RID/assets" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let a=[];try{a=JSON.parse(s)}catch{};const n=process.argv[1];for(const x of a)if(x.name===n)console.log(x.id)})' "$1" \
    | while read -r id; do [ -n "$id" ] && curl -sS -X DELETE -H "Authorization: token $TOKEN" "https://api.github.com/repos/$OWNER/$REPO/releases/assets/$id" >/dev/null; done
}
asset_state() {  # asset_state <name> → uploaded|starter|absent  (the upload's own response is unreliable on flaky wifi)
  curl -sS -H "Authorization: token $TOKEN" "https://api.github.com/repos/$OWNER/$REPO/releases/$RID/assets" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let a=[];try{a=JSON.parse(s)}catch{};const n=process.argv[1];const x=a.find(y=>y.name===n);console.log(x?x.state:"absent")})' "$1"
}
upload_asset() {  # upload_asset <filepath> <content-type>  — replace + UPLOAD, verify state via the API, retry
  local file="$1" ct="$2"
  local name; name="$(basename "$file")"
  echo "  ↑ uploading $name ($(du -h "$file" | awk '{print $1}')) …"
  local t st
  for t in 1 2 3; do
    del_asset "$name"
    # The POST response body is unreliable on a dropped connection (HTML/empty); ignore it and
    # confirm success by polling the asset STATE through the API instead.
    curl -sS --retry 2 -X POST -H "Authorization: token $TOKEN" -H "Content-Type: $ct" --data-binary @"$file" \
      "https://uploads.github.com/repos/$OWNER/$REPO/releases/$RID/assets?name=$name" -o /dev/null 2>/dev/null || true
    sleep 3; st="$(asset_state "$name")"
    if [ "$st" = "uploaded" ]; then echo "  ✓ $name uploaded"; return 0; fi
    echo "    attempt $t: state=$st — retrying"
  done
  echo "  ✗ $name failed to reach 'uploaded' after 3 attempts" >&2; return 1
}

set_manifest() {  # set_manifest <key:runtime|daemons> <sha> <bytes>   (values via argv — no interpolation)
  node -e 'const fs=require("fs");const p=process.argv[1],k=process.argv[2],sha=process.argv[3],b=Number(process.argv[4]);if(!sha||!b){console.error("refusing to write empty sha/bytes for "+k);process.exit(1)}const m=JSON.parse(fs.readFileSync(p,"utf8"));m[k].sha256=sha;m[k].bytes=b;fs.writeFileSync(p,JSON.stringify(m,null,2)+"\n");console.log("  ✎ manifest."+k+" → sha "+sha.slice(0,16)+"…, "+b+" B")' "$manifest" "$1" "$2" "$3"
}

# pack <srcdir> <name>: writes tarball + .sha256 to dist-deps; sets globals PACK_SHA / PACK_BYTES.
PACK_SHA=""; PACK_BYTES=""
pack() {
  local src="$1"
  local nm="$2"
  local tgz="$distdeps/${nm}-${arch}.tar.gz"
  mkdir -p "$distdeps"
  tar -C "$(dirname "$src")" -czf "$tgz" "$(basename "$src")"
  PACK_SHA="$(shasum -a 256 "$tgz" | awk '{print $1}')"
  PACK_BYTES="$(stat -f%z "$tgz")"
  printf '%s\n' "$PACK_SHA" > "$tgz.sha256"
  echo "  ⊞ packed $(basename "$tgz") ($(du -h "$tgz" | awk '{print $1}'), sha ${PACK_SHA:0:16}…)"
}

# ── 1. runtime ──────────────────────────────────────────────────────────────────────────────────
if [ "$DO_RUNTIME" -eq 1 ]; then
  echo "[release] === runtime ==="
  npm --prefix "$here" run build:runtime
  pack "$here/qvac-runtime" "qvac-runtime"
  upload_asset "$distdeps/qvac-runtime-${arch}.tar.gz" "application/gzip"
  upload_asset "$distdeps/qvac-runtime-${arch}.tar.gz.sha256" "text/plain"
  set_manifest runtime "$PACK_SHA" "$PACK_BYTES"
fi

# ── 2. daemons overlay ──────────────────────────────────────────────────────────────────────────
if [ "$DO_DAEMONS" -eq 1 ]; then
  echo "[release] === daemons ==="
  npm --prefix "$here" run build:daemons
  pack "$here/leash-daemons" "leash-daemons"
  upload_asset "$distdeps/leash-daemons-${arch}.tar.gz" "application/gzip"
  upload_asset "$distdeps/leash-daemons-${arch}.tar.gz.sha256" "text/plain"
  set_manifest daemons "$PACK_SHA" "$PACK_BYTES"
fi

# ── 3. web standalone (always — the app bundles it) ───────────────────────────────────────────────
echo "[release] === web build ==="
npm --prefix "$here/../web" run build

# ── 4. DMG (always, unless --no-dmg) ─────────────────────────────────────────────────────────────
if [ "$DO_DMG" -eq 1 ]; then
  echo "[release] === desktop build + DMG ==="
  npm --prefix "$here" run build:mac
  app="$here/dist/mac-arm64/Leash.app"
  echo "[release] deep ad-hoc re-sign (covers after-pack Resources) …"
  codesign --remove-signature "$app" 2>/dev/null || true
  codesign --force --deep --sign - --entitlements "$here/build/entitlements.mac.plist" "$app"
  codesign --verify --deep --strict "$app" && echo "  ✓ seal valid"
  rm -f "$here/dist/Leash-0.0.0.dmg"
  npx --prefix "$here" electron-builder --mac dmg --prepackaged "$app"
  echo "[release] ✓ DMG → $here/dist/Leash-0.0.0.dmg"
fi
echo "[release] done."
