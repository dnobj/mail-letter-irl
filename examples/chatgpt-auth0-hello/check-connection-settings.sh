#!/bin/bash

# Check full connection configuration
MGMT_TOKEN="$1"
CONNECTION_ID="con_KsLx9jreL6UbX7ZB"
DOMAIN="dev-ky21dxn3qmi71hjl.us.auth0.com"

if [ -z "$MGMT_TOKEN" ]; then
  echo "❌ Usage: $0 <management-api-token>"
  exit 1
fi

echo "🔍 Fetching full connection configuration..."
echo ""

curl -s "https://$DOMAIN/api/v2/connections/$CONNECTION_ID" \
  -H "Authorization: Bearer $MGMT_TOKEN" \
  | jq '{
      name,
      strategy,
      enabled_clients,
      is_domain_connection,
      metadata,
      options: {
        requires_username,
        enable_script_context,
        passwordPolicy,
        password_complexity_options,
        enabledDatabaseCustomization
      }
    }'
