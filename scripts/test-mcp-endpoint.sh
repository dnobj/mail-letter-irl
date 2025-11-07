#!/usr/bin/env bash
set -euo pipefail

URL=${1:-https://amitotically-gubernacular-elise.ngrok-free.dev/mcp}

curl -v -N \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: debug-session" \
  -d '{"jsonrpc":"2.0","id":"debug","method":"ping"}' \
  "$URL"
