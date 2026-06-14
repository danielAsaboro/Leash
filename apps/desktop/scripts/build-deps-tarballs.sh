#!/usr/bin/env bash
# Package the heavy, downloaded-after-install components as release tarballs + checksums, and
# regenerate deps-manifest.json (bundled in the app so it knows what/where to fetch).
#
# Stub-installer model: the DMG ships small (Electron + dashboard); the app downloads these into
# the user's base dir after Setup. Upload the dist-deps/* files as assets on a GitHub Release,
# then set `baseUrl` in src/main/deps-manifest.json to that release's download URL.
#
#   apps/desktop/scripts/build-qvac-runtime.sh   # build the runtime first
#   apps/desktop/scripts/build-deps-tarballs.sh  # then package it
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"        # apps/desktop
arch="${QVAC_PREBUILD_ARCH:-darwin-arm64}"
out="$here/dist-deps"
manifest="$here/src/main/deps-manifest.json"
mkdir -p "$out"

pack() {  # pack <srcdir> <name> -> tarball + sha; echoes "<file> <sha> <bytes>"
  local src="$1" name="$2"
  local tgz="$out/${name}-${arch}.tar.gz"
  [ -d "$src" ] || { echo "  ✗ $name: source $src missing — build it first" >&2; return 1; }
  tar -C "$(dirname "$src")" -czf "$tgz" "$(basename "$src")"
  local sha bytes
  sha=$(shasum -a 256 "$tgz" | awk '{print $1}')
  bytes=$(stat -f%z "$tgz")
  echo "$sha" > "$tgz.sha256"
  echo "  ✓ $(basename "$tgz")  $(du -h "$tgz" | awk '{print $1}')  sha=${sha:0:12}…" >&2
  echo "${name}-${arch}.tar.gz $sha $bytes"
}

echo "[deps] packaging tarballs ($arch) → $out"
rt=$(pack "$here/qvac-runtime" "qvac-runtime")
rt_file=$(echo "$rt" | awk '{print $1}'); rt_sha=$(echo "$rt" | awk '{print $2}'); rt_bytes=$(echo "$rt" | awk '{print $3}')

# Daemons overlay (optional — built by build-leash-daemons.sh; downloaded on-demand into the runtime).
dm_json=""
if [ -d "$here/leash-daemons" ]; then
  dm=$(pack "$here/leash-daemons" "leash-daemons")
  dm_file=$(echo "$dm" | awk '{print $1}'); dm_sha=$(echo "$dm" | awk '{print $2}'); dm_bytes=$(echo "$dm" | awk '{print $3}')
  dm_json=",
  \"daemons\": {
    \"file\": \"$dm_file\",
    \"sha256\": \"$dm_sha\",
    \"bytes\": $dm_bytes,
    \"extractDir\": \"leash-daemons\"
  }"
fi

# Preserve an existing baseUrl if the manifest already has one (don't clobber the user's release URL).
base_url=$(node -e "try{console.log(require('$manifest').baseUrl||'')}catch{console.log('')}" 2>/dev/null)
[ -n "$base_url" ] || base_url="https://github.com/OWNER/REPO/releases/download/desktop-deps-v1"

cat > "$manifest" <<JSON
{
  "version": "1",
  "arch": "$arch",
  "baseUrl": "$base_url",
  "runtime": {
    "file": "$rt_file",
    "sha256": "$rt_sha",
    "bytes": $rt_bytes,
    "extractDir": "qvac-runtime",
    "cli": "qvac-runtime/node_modules/@qvac/cli/dist/index.js"
  }$dm_json
}
JSON
echo "[deps] wrote $manifest (baseUrl: $base_url)"
echo "[deps] → upload dist-deps/* to the GitHub Release, then set baseUrl in deps-manifest.json if needed."
