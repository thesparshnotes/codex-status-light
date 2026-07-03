#!/bin/sh
set -eu

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

xml_escape() {
  printf '%s' "$1" | sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' \
    -e "s/'/\&apos;/g"
}

[ "$(uname -s)" = "Darwin" ] || fail "Codex Usage Status only runs on macOS."
command -v node >/dev/null 2>&1 || fail "Node.js is required. Install Node 22 or newer, then rerun this script."

NODE_BIN="$(command -v node)"
NODE_VERSION="$(node -p 'process.versions.node' 2>/dev/null || true)"
[ -n "$NODE_VERSION" ] || fail "Could not read the installed Node.js version."
NODE_MAJOR="${NODE_VERSION%%.*}"
[ "$NODE_MAJOR" -ge 22 ] || fail "Node.js 22 or newer is required. Found Node $NODE_VERSION at $NODE_BIN."

[ -f "$HOME/.codex/auth.json" ] || fail "Codex Desktop does not look signed in. Open Codex Desktop and sign in first."

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
DAEMON_DIR="$ROOT_DIR/codex-status-light"
APP_SRC="$ROOT_DIR/Codex Usage Status.app"
APP_DST="/Applications/Codex Usage Status.app"
PLIST="$HOME/Library/LaunchAgents/com.sparsh.codex-light.plist"
LOG_DIR="$HOME/.codex-light"

[ -d "$DAEMON_DIR" ] || fail "Missing bundled daemon at $DAEMON_DIR."
[ -f "$DAEMON_DIR/bin/codex-light.mjs" ] || fail "Missing daemon entrypoint."
[ -d "$APP_SRC" ] || fail "Missing bundled app at $APP_SRC."

printf 'Installing daemon dependencies...\n'
(cd "$DAEMON_DIR" && npm install)

mkdir -p "$(dirname "$PLIST")" "$LOG_DIR"

NODE_XML="$(xml_escape "$NODE_BIN")"
ENTRY_XML="$(xml_escape "$DAEMON_DIR/bin/codex-light.mjs")"
WORKDIR_XML="$(xml_escape "$DAEMON_DIR")"
LOG_XML="$(xml_escape "$LOG_DIR/daemon.log")"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.sparsh.codex-light</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_XML</string>
    <string>$ENTRY_XML</string>
    <string>serve</string>
    <string>--port</string>
    <string>4173</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>$WORKDIR_XML</string>
  <key>StandardOutPath</key>
  <string>$LOG_XML</string>
  <key>StandardErrorPath</key>
  <string>$LOG_XML</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/com.sparsh.codex-light"

if [ -w "/Applications" ]; then
  rm -rf "$APP_DST"
  cp -R "$APP_SRC" "$APP_DST"
  APP_LOCATION="$APP_DST"
else
  open "$APP_SRC" >/dev/null 2>&1 || true
  APP_LOCATION="$APP_SRC"
fi

printf '\nInstalled Codex Usage Status.\n'
printf 'Menu bar app: %s\n' "$APP_LOCATION"
printf 'LaunchAgent: %s\n' "$PLIST"
printf 'Verify with: curl -s http://127.0.0.1:4173/api/status\n'
