#!/bin/sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$ROOT_DIR/dist/Codex Usage Status.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"

swift build --package-path "$ROOT_DIR"

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR"
cp "$ROOT_DIR/Support/Info.plist" "$CONTENTS_DIR/Info.plist"
cp "$ROOT_DIR/.build/debug/CodexUsageStatusDashboard" "$MACOS_DIR/CodexUsageStatusDashboard"
chmod +x "$MACOS_DIR/CodexUsageStatusDashboard"

printf '%s\n' "$APP_DIR"
