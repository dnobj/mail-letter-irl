#!/bin/bash

# Script to enable connection for a dynamically registered Auth0 client
# Usage: ./enable-connection-simple.sh <management-api-token> [client-id]

MGMT_TOKEN="$1"
CLIENT_ID="${2:-yaMC4dA62DQAhnRbDJXSoNoqBX8QHPKW}"
CONNECTION_ID="con_KsLx9jreL6UbX7ZB"
DOMAIN="dev-ky21dxn3qmi71hjl.us.auth0.com"

if [ -z "$MGMT_TOKEN" ]; then
  echo "❌ Usage: $0 <management-api-token> [client-id]"
  exit 1
fi

echo "🔧 Enabling connection for client: $CLIENT_ID"
echo ""

# Get current enabled clients
echo "📋 Fetching current enabled clients..."
CURRENT=$(curl -s "https://$DOMAIN/api/v2/connections/$CONNECTION_ID" \
  -H "Authorization: Bearer $MGMT_TOKEN")

# Check for error
if echo "$CURRENT" | jq -e '.error' > /dev/null 2>&1; then
  echo "❌ Error fetching connection:"
  echo "$CURRENT" | jq '.'
  exit 1
fi

echo "Current enabled clients:"
echo "$CURRENT" | jq -r '.enabled_clients[]'
echo ""

# Build new array with existing + new client
NEW_CLIENTS=$(echo "$CURRENT" | jq -c ".enabled_clients + [\"$CLIENT_ID\"] | unique")

echo "🔧 Adding client to connection..."
echo "New enabled_clients array:"
echo "$NEW_CLIENTS" | jq -r '.[]'
echo ""

# Update the connection
RESPONSE=$(curl -s -w "\n%{http_code}" -X PATCH "https://$DOMAIN/api/v2/connections/$CONNECTION_ID" \
  -H "Authorization: Bearer $MGMT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"enabled_clients\": $NEW_CLIENTS}")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)

if [ "$HTTP_CODE" = "200" ]; then
  echo "✅ Success! Connection enabled for client."
  echo ""
  echo "✅ Try connecting from ChatGPT again!"
else
  echo "❌ Error: HTTP $HTTP_CODE"
  echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
  exit 1
fi
