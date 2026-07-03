#!/bin/sh
set -eu

PLIST="$HOME/Library/LaunchAgents/com.sparsh.codex-light.plist"

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
rm -f "$PLIST"

printf 'removed %s\n' "$PLIST"
