#!/bin/bash

# Automatically update .env with current ngrok URL
# Run this whenever your ngrok URL changes

NGROK_API="http://localhost:4040/api"

echo "🔄 Updating .env with current ngrok URL"
echo "========================================"
echo ""

# Check if ngrok is running
if ! curl -s "$NGROK_API/tunnels" > /dev/null 2>&1; then
  echo "❌ ngrok is not running"
  echo "Start ngrok with: ngrok http 8788"
  exit 1
fi

# Get HTTPS URL
HTTPS_URL=$(curl -s "$NGROK_API/tunnels" | jq -r '.tunnels[] | select(.proto == "https") | .public_url')

if [ -z "$HTTPS_URL" ]; then
  echo "❌ No HTTPS tunnel found"
  exit 1
fi

# Extract domain (without https://)
DOMAIN=$(echo "$HTTPS_URL" | sed 's|https://||')

echo "Found ngrok URL: $HTTPS_URL"
echo "Domain: $DOMAIN"
echo ""

# Check if .env exists
if [ ! -f .env ]; then
  echo "❌ .env file not found"
  echo "Copy .env.example to .env first:"
  echo "  cp .env.example .env"
  exit 1
fi

# Backup .env
cp .env .env.backup
echo "✅ Backed up .env to .env.backup"

# Update PUBLIC_BASE_URL
sed -i "s|PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=$HTTPS_URL|g" .env

# Update ALLOWED_ORIGINS (add ngrok domain if not present)
if ! grep -q "$HTTPS_URL" .env; then
  sed -i "s|ALLOWED_ORIGINS=\(.*\)|ALLOWED_ORIGINS=\1,$HTTPS_URL|g" .env
fi

# Update ALLOWED_HOSTS (add ngrok domain if not present)
if ! grep -q "$DOMAIN" .env; then
  sed -i "s|ALLOWED_HOSTS=\(.*\)|ALLOWED_HOSTS=\1,$DOMAIN,$DOMAIN:443|g" .env
fi

echo "✅ Updated .env with:"
echo "   PUBLIC_BASE_URL=$HTTPS_URL"
echo ""
echo "Current .env settings:"
grep "PUBLIC_BASE_URL" .env
grep "ALLOWED_ORIGINS" .env
grep "ALLOWED_HOSTS" .env
echo ""
echo "🔄 Restart your server to use the new URL:"
echo "   npm run dev"
