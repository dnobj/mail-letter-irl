#!/bin/bash

# ngrok Status Checker
# Queries the ngrok local agent API for tunnel status

NGROK_API="http://localhost:4040/api"

echo "🌐 ngrok Tunnel Status"
echo "======================="
echo ""

# Check if ngrok is running
if ! curl -s "$NGROK_API/tunnels" > /dev/null 2>&1; then
  echo "❌ ngrok is not running or API not accessible at $NGROK_API"
  echo ""
  echo "Start ngrok with: ngrok http 8788"
  exit 1
fi

# Get tunnel info
TUNNELS=$(curl -s "$NGROK_API/tunnels")

# Parse and display tunnel information
echo "$TUNNELS" | jq -r '.tunnels[] | "
Tunnel: \(.name)
  Public URL:  \(.public_url)
  Protocol:    \(.proto)
  Target:      \(.config.addr)
  Connections: \(.metrics.conns.count) total, \(.metrics.conns.gauge) active
  HTTP Reqs:   \(.metrics.http.count) total
  Inspect URL: http://localhost:4040
  ---
"'

# Extract just the HTTPS URL for easy copying
HTTPS_URL=$(echo "$TUNNELS" | jq -r '.tunnels[] | select(.proto == "https") | .public_url')

if [ -n "$HTTPS_URL" ]; then
  echo ""
  echo "✅ Your public HTTPS URL:"
  echo "   $HTTPS_URL"
  echo ""
  echo "📋 Use this in your .env file:"
  echo "   PUBLIC_BASE_URL=$HTTPS_URL"
  echo ""
  echo "🔍 View traffic: http://localhost:4040"
fi
