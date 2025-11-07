#!/usr/bin/env bash
set -euo pipefail

URL=${1:-https://amitotically-gubernacular-elise.ngrok-free.dev/mcp}

curl -v -N \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"init","method":"initialize","params":{"client":{"name":"debug","version":"0.0.1"},"capabilities":{}}}' \
  "$URL"
