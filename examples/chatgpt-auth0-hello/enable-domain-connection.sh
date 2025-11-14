#!/bin/bash

# Enable connection at domain level for third-party clients
MGMT_TOKEN="$1"
CONNECTION_ID="con_KsLx9jreL6UbX7ZB"
DOMAIN="dev-ky21dxn3qmi71hjl.us.auth0.com"

if [ -z "$MGMT_TOKEN" ]; then
  echo "❌ Usage: $0 <management-api-token>"
  exit 1
fi

echo "🔧 Enabling connection at domain level (for third-party clients)..."
echo ""

# Try setting is_domain_connection to true
RESPONSE=$(curl -s -w "\n%{http_code}" -X PATCH "https://$DOMAIN/api/v2/connections/$CONNECTION_ID" \
  -H "Authorization: Bearer $MGMT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "is_domain_connection": true
  }')

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)

if [ "$HTTP_CODE" = "200" ]; then
  echo "✅ Success! Connection is now domain-level."
  echo ""
  echo "$BODY" | jq '{name, is_domain_connection, enabled_clients}'
  echo ""
  echo "✅ Try connecting from ChatGPT again!"
else
  echo "❌ Error: HTTP $HTTP_CODE"
  echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
  echo ""
  echo "💡 This might not be the right approach. Let's check connection settings."
fi
