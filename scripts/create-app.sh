#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  echo "OPENAI_API_KEY is not set. Export it before running this script." >&2
  exit 1
fi

APP_NAME=${1:-"Mail Letter IRL"}
MANIFEST_URL=${2:-"https://amitotically-gubernacular-elise.ngrok-free.dev/manifest.json"}
MCP_URL=${3:-"https://amitotically-gubernacular-elise.ngrok-free.dev/mcp"}

curl https://api.openai.com/v1/apps \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d @<(cat <<PAYLOAD
{
  "name": "${APP_NAME}",
  "description": "Draft, preview, and mail letters via Letter IRL.",
  "manifestUrl": "${MANIFEST_URL}",
  "mcp": {
    "serverUrl": "${MCP_URL}"
  }
}
PAYLOAD
)
