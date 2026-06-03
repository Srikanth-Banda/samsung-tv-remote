#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if ! node -e "require('ws')" 2>/dev/null; then
  echo "Installing ws..."
  npm install ws
fi

HOSTNAME=$(scutil --get LocalHostName 2>/dev/null || hostname)
IP=$(ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo 'YOUR_IP')

echo ""
echo "----------------------------------------------"
echo "  TV Remote — open on any phone on this WiFi:"
echo ""
echo "    http://${HOSTNAME}.local:8080"
echo "    http://${IP}:8080            (fallback)"
echo ""
echo "  On the phone: tap Share → Add to Home Screen"
echo "----------------------------------------------"
echo ""

exec node server.js
