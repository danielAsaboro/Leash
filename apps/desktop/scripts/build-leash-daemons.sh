#!/usr/bin/env bash
# Build the "leash-daemons" OVERLAY bundle: the dashboard-managed daemons (hypha, watcher, newsroom,
# leash-broker, leash-mcp, leash-tools-mcp) + their @mycelium packages + the npm deps
# (the scheduling engine is the separate `mcp-cron` Go binary, packaged by Task 7, not a tsx daemon).
# the base qvac-runtime DOESN'T already carry. Downloaded on-demand (like the runtime) and extracted
# INTO <qvac-runtime>/.leash-daemons/ — so the daemons resolve @qvac/sdk + tsx from the runtime one
# dir up (no duplicating the heavy @qvac engines) and their own deps from this overlay's node_modules.
#
#   apps/desktop/scripts/build-qvac-runtime.sh    # the base runtime first (provides @qvac + tsx)
#   apps/desktop/scripts/build-leash-daemons.sh   # then this overlay
#   apps/desktop/scripts/build-deps-tarballs.sh   # package + manifest
set -euo pipefail

ARCH_KEEP="${QVAC_PREBUILD_ARCH:-darwin-arm64}"
here="$(cd "$(dirname "$0")/.." && pwd)"        # apps/desktop
repo="$(cd "$here/../.." && pwd)"               # monorepo root
out="$here/leash-daemons"

DAEMONS=(hypha leash-watch newsroom leash-broker leash-mcp leash-tools-mcp)
MYC=(shared senses mesh mind db leash-core)     # @mycelium/* the daemons import (prebuilt dist)

echo "[leash-daemons] building overlay → $out (keep $ARCH_KEEP prebuilds)"
rm -rf "$out"
mkdir -p "$out/apps" "$out/node_modules/@mycelium"

# 1. The EXTRA deps (everything the daemons/@mycelium need that the base runtime lacks — NOT @qvac, NOT tsx).
cat > "$out/package.json" <<'JSON'
{ "name": "leash-daemons", "private": true, "version": "0.0.0", "license": "Apache-2.0",
  "dependencies": {
    "hyperswarm": "4.17.0", "autobase": "^7.28", "corestore": "7.10.0", "hyperbee": "2.27.3",
    "blind-pairing": "^2.3", "b4a": "1.8.1", "bonjour-service": "^1.4.0", "jsonrepair": "^3.14.0",
    "@modelcontextprotocol/sdk": "^1.29.0", "zod": "^4.4.3", "ai": "^6.0.204", "undici": "^8.3.0",
    "@prisma/client": "^6.1.0", "prisma": "^6.1.0",
    "@solana/web3.js": "^1.98.4", "@solana/spl-token": "^0.4.14", "ethers": "^6.14.3",
    "@tetherto/wdk-wallet-evm": "^1.0.0-beta.13", "@x402/core": "^2.14.0", "@x402/evm": "^2.14.0",
    "@semanticio/wdk-wallet-evm-x402-facilitator": "^1.0.0-beta.2"
  } }
JSON
( cd "$out" && npm install --no-audit --no-fund --prefer-offline --omit=dev 2>&1 | tail -3 )

# 2. Prebuilt @mycelium packages (dist + package.json; they import @qvac from the runtime parent).
for p in "${MYC[@]}"; do
  src="$repo/packages/$p"
  [ -d "$src/dist" ] || { echo "  ✗ @mycelium/$p has no dist/ — run \`npm run build\` (tsc -b) first" >&2; exit 1; }
  mkdir -p "$out/node_modules/@mycelium/$p"
  cp -R "$src/dist" "$out/node_modules/@mycelium/$p/dist"
  cp "$src/package.json" "$out/node_modules/@mycelium/$p/package.json"
  [ -d "$src/prisma" ] && cp -R "$src/prisma" "$out/node_modules/@mycelium/$p/prisma" || true
done

# 3. Daemon source (src + package.json + tsconfig) — tsx runs the .ts entry directly.
for d in "${DAEMONS[@]}"; do
  src="$repo/apps/$d"
  mkdir -p "$out/apps/$d"
  cp -R "$src/src" "$out/apps/$d/src"
  cp "$src/package.json" "$out/apps/$d/package.json"
  for t in tsconfig.json tsconfig.node.json; do [ -f "$src/$t" ] && cp "$src/$t" "$out/apps/$d/$t" || true; done
done

# 4. Prisma client (newsroom → @mycelium/db). The schema has no `output`, so `prisma generate` writes
#    the generated client + arch query-engine into the WORKSPACE's node_modules/.prisma. Generate (to
#    refresh it) then COPY that generated client into the overlay so it ships with the daemon bundle.
if [ -f "$repo/packages/db/prisma/schema.prisma" ]; then
  echo "[leash-daemons] generating + staging prisma client …"
  ( cd "$repo" && npx prisma generate --schema packages/db/prisma/schema.prisma 2>&1 | tail -2 ) || echo "  ⚠️ prisma generate failed"
  if [ -d "$repo/node_modules/.prisma" ]; then
    rm -rf "$out/node_modules/.prisma"
    cp -R "$repo/node_modules/.prisma" "$out/node_modules/.prisma"
    echo "  ✓ staged generated prisma client ($(du -sh "$out/node_modules/.prisma" | awk '{print $1}'))"
  else
    echo "  ⚠️ no generated .prisma in workspace — newsroom may not start (others unaffected)"
  fi
fi

# 4b. Vendor the mcp-cron scheduling-engine binary (Go) for this arch into the overlay. mcp-cron
#     ships prebuilt per-arch binaries as npm packages (mcp-cron-<arch>), and ARCH_KEEP (e.g.
#     darwin-arm64) is exactly that suffix. The packaged app has no system npx, so services.ts runs
#     THIS vendored binary directly at <overlay>/mcp-cron/<bin> (dev still uses `npx -y mcp-cron`).
echo "[leash-daemons] vendoring mcp-cron binary ($ARCH_KEEP) …"
mcp_bin="mcp-cron"; case "$ARCH_KEEP" in windows-*) mcp_bin="mcp-cron.exe";; esac
mcp_tmp="$(mktemp -d)"
if ( cd "$mcp_tmp" && npm pack "mcp-cron-$ARCH_KEEP" >/dev/null 2>&1 ); then
  tar -C "$mcp_tmp" -xzf "$mcp_tmp"/*.tgz
  if [ -f "$mcp_tmp/package/bin/$mcp_bin" ]; then
    mkdir -p "$out/mcp-cron"
    cp "$mcp_tmp/package/bin/$mcp_bin" "$out/mcp-cron/$mcp_bin"
    chmod +x "$out/mcp-cron/$mcp_bin"
    echo "  ✓ vendored mcp-cron ($(du -h "$out/mcp-cron/$mcp_bin" | awk '{print $1}'))"
  else
    echo "  ⚠️ mcp-cron-$ARCH_KEEP has no bin/$mcp_bin — the scheduler won't run in the packaged app" >&2
  fi
else
  echo "  ⚠️ npm pack mcp-cron-$ARCH_KEEP failed — the scheduler won't be bundled (needs network at build time)" >&2
fi
rm -rf "$mcp_tmp"

# 5. Arch-prune native prebuilds (corestore/hyperswarm/sodium/etc. ship every platform).
find "$out/node_modules" -type d -name prebuilds 2>/dev/null | while read -r pb; do
  for plat in "$pb"/*/; do [ "$(basename "$plat")" = "$ARCH_KEEP" ] || rm -rf "$plat"; done
done

echo "[leash-daemons] done — size: $(du -sh "$out" | awk '{print $1}')"
echo "[leash-daemons] daemons: $(ls "$out/apps" | tr '\n' ' ')"
echo "[leash-daemons] @mycelium: $(ls "$out/node_modules/@mycelium" | tr '\n' ' ')"
