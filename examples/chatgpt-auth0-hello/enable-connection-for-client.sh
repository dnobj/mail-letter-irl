#!/bin/bash

# Script to enable connection for a dynamically registered Auth0 client
# Usage: ./enable-connection-for-client.sh <client-id>

CLIENT_ID=${1:-"yaMC4dA62DQAhnRbDJXSoNoqBX8QHPKW"}
CONNECTION_ID="con_KsLx9jreL6UbX7ZB"  # Username-Password-Authentication
DOMAIN="dev-ky21dxn3qmi71hjl.us.auth0.com"

echo "🔧 Enabling connection for client: $CLIENT_ID"
echo ""
echo "⚠️  You need an Auth0 Management API token to run this."
echo "    Get one from: https://manage.auth0.com/dashboard/us/$DOMAIN/apis"
echo "    Look for 'Auth0 Management API' and create a test token"
echo ""
read -p "Paste your Management API token: " MGMT_TOKEN

# Trim whitespace from token
MGMT_TOKEN=$(echo "$MGMT_TOKEN" | xargs)

if [ -z "$MGMT_TOKEN" ]; then
  echo "❌ No token provided"
  exit 1
fi

echo "Token length: ${#MGMT_TOKEN} characters"

echo ""
echo "📋 Fetching current enabled clients..."

# Get current enabled_clients array
CURRENT_CLIENTS=$(curl -s "https://$DOMAIN/api/v2/connections/$CONNECTION_ID" \
  -H "Authorization: Bearer $MGMT_TOKEN" \
  | jq -r '.enabled_clients[]' 2>/dev/null)

if [ -z "$CURRENT_CLIENTS" ]; then
  echo "⚠️  No existing enabled clients found (or error fetching). Adding only new client."
  ENABLED_CLIENTS_JSON="[\"$CLIENT_ID\"]"
else
  echo "Found existing enabled clients:"
  echo "$CURRENT_CLIENTS"
  echo ""

  # Check if client already enabled
  if echo "$CURRENT_CLIENTS" | grep -q "^$CLIENT_ID$"; then
    echo "✅ Client $CLIENT_ID is already enabled for this connection!"
    exit 0
  fi

  # Build JSON array with existing + new client
  ENABLED_CLIENTS_JSON="["
  for client in $CURRENT_CLIENTS; do
    ENABLED_CLIENTS_JSON="${ENABLED_CLIENTS_JSON}\"$client\","
  done
  ENABLED_CLIENTS_JSON="${ENABLED_CLIENTS_JSON}\"$CLIENT_ID\"]"
fi

echo ""
echo "🔧 Enabling connection for new client..."
echo "   Client ID: $CLIENT_ID"
echo ""

# Enable the connection for the client (preserving existing ones)
RESPONSE=$(curl -s -w "\n%{http_code}" -X PATCH "https://$DOMAIN/api/v2/connections/$CONNECTION_ID" \
  -H "Authorization: Bearer $MGMT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"enabled_clients\": $ENABLED_CLIENTS_JSON}")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)

if [ "$HTTP_CODE" = "200" ]; then
  echo "✅ Success! Connection enabled for client."
  echo ""
  echo "Updated enabled_clients:"
  echo "$BODY" | jq -r '.enabled_clients[]' 2>/dev/null || echo "$BODY"
  echo ""
  echo "✅ Try connecting from ChatGPT again!"
else
  echo "❌ Error: HTTP $HTTP_CODE"
  echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
  exit 1
fi
