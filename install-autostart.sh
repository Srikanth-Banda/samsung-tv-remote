#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
PROJECT_DIR="$(pwd)"
NODE_BIN="$(which node || true)"

if [ -z "$NODE_BIN" ]; then
  echo "Error: 'node' not found in PATH. Install Node.js first (e.g. 'brew install node')."
  exit 1
fi

if ! node -e "require('ws')" 2>/dev/null; then
  echo "Installing ws..."
  npm install ws
fi

PLIST="$HOME/Library/LaunchAgents/com.srikanth.tvremote.plist"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.srikanth.tvremote</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${PROJECT_DIR}/server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${PROJECT_DIR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${PROJECT_DIR}/tvremote.log</string>
  <key>StandardErrorPath</key>
  <string>${PROJECT_DIR}/tvremote.log</string>
</dict>
</plist>
EOF

# Reload (ignore errors if not loaded)
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

HOSTNAME=$(scutil --get LocalHostName 2>/dev/null || hostname)
echo ""
echo "Installed. TV Remote will now auto-start on login and restart if it crashes."
echo ""
echo "  URL:       http://${HOSTNAME}.local:8080"
echo "  Logs:      tail -f ${PROJECT_DIR}/tvremote.log"
echo "  Stop:      launchctl unload ${PLIST}"
echo "  Uninstall: launchctl unload ${PLIST} && rm ${PLIST}"
echo ""
