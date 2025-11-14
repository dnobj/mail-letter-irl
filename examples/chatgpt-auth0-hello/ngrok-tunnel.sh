#!/bin/bash

# Start ngrok tunnel for the MCP server
# Automatically updates .env with the new URL

PORT=${1:-8788}

echo "🚀 Starting ngrok tunnel for port $PORT"
echo "======================================="
echo ""

# Check if ngrok is already running
if curl -s http://localhost:4040/api/tunnels > /dev/null 2>&1; then
  echo "⚠️  ngrok appears to be already running"
  echo ""
  EXISTING_URL=$(curl -s http://localhost:4040/api/tunnels | jq -r '.tunnels[] | select(.proto == "https") | .public_url')
  if [ -n "$EXISTING_URL" ]; then
    echo "Existing tunnel: $EXISTING_URL"
    echo ""
    read -p "Stop and restart? [y/N] " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
      echo "Keeping existing tunnel"
      exit 0
    fi
    # Kill existing ngrok
    pkill ngrok
    sleep 2
  fi
fi

# Start ngrok in background
echo "Starting ngrok http $PORT..."
ngrok http $PORT --log=stdout > /tmp/ngrok.log 2>&1 &

# Wait for ngrok to start
echo -n "Waiting for ngrok to initialize"
for i in {1..10}; do
  if curl -s http://localhost:4040/api/tunnels > /dev/null 2>&1; then
    echo " ✅"
    break
  fi
  echo -n "."
  sleep 1
done

if ! curl -s http://localhost:4040/api/tunnels > /dev/null 2>&1; then
  echo " ❌"
  echo "Failed to start ngrok"
  echo "Check /tmp/ngrok.log for errors"
  exit 1
fi

# Get tunnel URL
HTTPS_URL=$(curl -s http://localhost:4040/api/tunnels | jq -r '.tunnels[] | select(.proto == "https") | .public_url')

if [ -z "$HTTPS_URL" ]; then
  echo "❌ Failed to get tunnel URL"
  exit 1
fi

echo ""
echo "✅ ngrok tunnel started!"
echo ""
echo "Public URL: $HTTPS_URL"
echo "Inspect UI: http://localhost:4040"
echo "Forwarding to: http://localhost:$PORT"
echo ""

# Update .env if it exists
if [ -f .env ]; then
  read -p "Update .env with this URL? [Y/n] " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Nn]$ ]]; then
    ./ngrok-update-env.sh
  fi
fi

echo ""
echo "💡 Tips:"
echo "   - View traffic at http://localhost:4040"
echo "   - Check status: ./ngrok-status.sh"
echo "   - View logs: ./ngrok-logs.sh"
echo "   - Stop: pkill ngrok"
echo ""
echo "🔗 Manifest URL for ChatGPT:"
echo "   $HTTPS_URL/manifest.json"
