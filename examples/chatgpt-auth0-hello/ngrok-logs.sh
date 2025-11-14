#!/bin/bash

# ngrok Request Log Viewer
# Shows recent HTTP requests through ngrok tunnel

NGROK_API="http://localhost:4040/api"

echo "📊 ngrok Request Logs"
echo "===================="
echo ""

# Check if ngrok is running
if ! curl -s "$NGROK_API/tunnels" > /dev/null 2>&1; then
  echo "❌ ngrok is not running"
  exit 1
fi

# Get request history
REQUESTS=$(curl -s "$NGROK_API/requests/http")

# Count total requests
TOTAL=$(echo "$REQUESTS" | jq -r '.requests | length')

echo "Total Requests: $TOTAL"
echo ""

if [ "$TOTAL" -eq 0 ]; then
  echo "No requests yet. Make some requests to see them here!"
  exit 0
fi

# Show last 20 requests
echo "Recent Requests (last 20):"
echo "=========================="
echo ""

echo "$REQUESTS" | jq -r '.requests | reverse | .[:20] | .[] | "
\(.start_time) - \(.request.method) \(.request.uri)
  From:     \(.request.headers."X-Forwarded-For"[0] // "unknown")
  Status:   \(.response.status_code // "pending")
  Duration: \(.duration)ns
  User-Agent: \(.request.headers."User-Agent"[0] // "unknown")
  ---
"'

# Summary by status code
echo ""
echo "Summary by Status Code:"
echo "======================="
echo "$REQUESTS" | jq -r '.requests | group_by(.response.status_code) | .[] | "\(.[0].response.status_code // "pending"): \(length) requests"'

echo ""
echo "💡 View full details at: http://localhost:4040"
echo "💡 Click on any request to see headers, body, and replay options"
