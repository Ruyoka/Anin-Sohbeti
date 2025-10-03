#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$PROJECT_ROOT/dist"
ARCHIVE_NAME="anin-sohbeti-android.zip"
ARCHIVE_PATH="$DIST_DIR/$ARCHIVE_NAME"

mkdir -p "$DIST_DIR"
rm -f "$ARCHIVE_PATH"

(
  cd "$PROJECT_ROOT"
  zip -rq "$ARCHIVE_PATH" android-app -x "android-app/.gradle/*" "android-app/local.properties" "android-app/.idea/*"
)

echo "Created archive at $ARCHIVE_PATH"
