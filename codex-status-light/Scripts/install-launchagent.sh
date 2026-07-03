#!/bin/sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/com.sparsh.codex-light.plist"
LOG_DIR="$HOME/.codex-light"
NODE_BIN="$(command -v node)"

mkdir -p "$(dirname "$PLIST")" "$LOG_DIR"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.sparsh.codex-light</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$ROOT_DIR/bin/codex-light.mjs</string>
    <string>serve</string>
    <string>--port</string>
    <string>4173</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>$ROOT_DIR</string>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/daemon.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/daemon.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/com.sparsh.codex-light"

printf '%s\n' "$PLIST"
