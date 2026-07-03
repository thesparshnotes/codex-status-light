#!/bin/sh
set -eu

LABEL="local.codex.usage-status-dashboard"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_VALUE="$(id -u)"

launchctl bootout "gui/$UID_VALUE" "$PLIST_PATH" >/dev/null 2>&1 || true
rm -f "$PLIST_PATH"

printf 'Removed login item: %s\n' "$PLIST_PATH"
