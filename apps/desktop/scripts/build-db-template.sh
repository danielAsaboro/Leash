#!/usr/bin/env bash
# Produce an empty (schema-only) newsroom.db that the desktop app copies into a
# fresh install's db path on first run. Uses `prisma db push` so it needs no
# migrations history. Run from anywhere.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="$ROOT/apps/desktop/resources/newsroom-template.db"
rm -f "$OUT"
DATABASE_URL="file:$OUT" npx prisma db push \
  --schema "$ROOT/packages/db/prisma/schema.prisma" \
  --skip-generate --accept-data-loss
echo "built template: $OUT ($(du -h "$OUT" | cut -f1))"
