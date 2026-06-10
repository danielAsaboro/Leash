#!/usr/bin/env bash
# Orchestrate a hub+edge two-process mesh smoke.
# Usage: _two-proc-smoke.sh <npm-script> [hub-extra-args...]
# Starts `npm run -s <script> hub`, parses its printed invite from the
# "edge: npm run <script> edge <invite>" line, runs the edge, waits for both.
set -uo pipefail
SCRIPT="$1"; shift || true
HUBLOG="$(mktemp -t hubsmoke.XXXXXX)"
EDGELOG="$(mktemp -t edgesmoke.XXXXXX)"

# Start hub in background.
npm run -s "$SCRIPT" hub "$@" >"$HUBLOG" 2>&1 &
HUBPID=$!

# Wait up to 30s for the invite line.
INV=""
for i in $(seq 1 60); do
  INV="$(grep -m1 '^edge: npm run' "$HUBLOG" 2>/dev/null | awk '{print $NF}')"
  [ -n "$INV" ] && break
  if ! kill -0 "$HUBPID" 2>/dev/null; then break; fi
  sleep 0.5
done

if [ -z "$INV" ]; then
  echo "!! never saw invite from hub. Hub log:"; cat "$HUBLOG"
  kill "$HUBPID" 2>/dev/null; wait "$HUBPID" 2>/dev/null
  rm -f "$HUBLOG" "$EDGELOG"; exit 2
fi
echo ">> got invite: ${INV:0:24}…"

# Run the edge foreground.
npm run -s "$SCRIPT" edge "$INV" >"$EDGELOG" 2>&1
EDGERC=$?

# Give the hub a moment to observe replication, then wait for it to exit.
wait "$HUBPID" 2>/dev/null
HUBRC=$?

echo "----- HUB -----"; tail -12 "$HUBLOG"
echo "----- EDGE (rc=$EDGERC) -----"; tail -12 "$EDGELOG"
echo "<<HUBRC=$HUBRC EDGERC=$EDGERC>>"
rm -f "$HUBLOG" "$EDGELOG"
[ "$EDGERC" -eq 0 ] && [ "$HUBRC" -eq 0 ]
