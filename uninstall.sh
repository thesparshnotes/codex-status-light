#!/bin/sh
set -eu

[ "$(uname -s)" = "Darwin" ] || {
  printf 'Codex Usage Status only runs on macOS.\n' >&2
  exit 1
}

PLIST="$HOME/Library/LaunchAgents/com.sparsh.codex-light.plist"
APP_DST="/Applications/Codex Usage Status.app"

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
rm -rf "$HOME/.codex-light"

if [ -d "$APP_DST" ]; then
  rm -rf "$APP_DST"
fi

printf 'Removed Codex Usage Status daemon, local status data, and installed app if present.\n'
