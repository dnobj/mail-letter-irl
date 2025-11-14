#!/bin/bash

# Startup script for ChatGPT Auth0 Hello World MCP Server

set -e

echo "🚀 Starting ChatGPT Auth0 Hello World MCP Server"
echo ""

# Check if .env exists
if [ ! -f .env ]; then
  echo "❌ Error: .env file not found"
  echo "📋 Please copy .env.example to .env and configure it:"
  echo "   cp .env.example .env"
  echo "   nano .env  # or use your preferred editor"
  exit 1
fi

# Load environment variables
export $(cat .env | grep -v '^#' | xargs)

# Validate required environment variables
REQUIRED_VARS=(
  "PUBLIC_BASE_URL"
  "AUTH0_ISSUER"
  "AUTH0_AUTHORIZATION_ENDPOINT"
  "AUTH0_TOKEN_ENDPOINT"
  "AUTH0_JWKS_URI"
  "AUTH0_AUDIENCE"
)

MISSING_VARS=()
for VAR in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!VAR}" ]; then
    MISSING_VARS+=("$VAR")
  fi
done

if [ ${#MISSING_VARS[@]} -gt 0 ]; then
  echo "❌ Error: Missing required environment variables:"
  for VAR in "${MISSING_VARS[@]}"; do
    echo "   - $VAR"
  done
  echo ""
  echo "📋 Please configure these in your .env file"
  exit 1
fi

echo "✅ Environment variables validated"
echo ""

# Check if node_modules exists
if [ ! -d node_modules ]; then
  echo "📦 Installing dependencies..."
  npm install
  echo ""
fi

# Run the server
echo "🎯 Configuration:"
echo "   Public URL: $PUBLIC_BASE_URL"
echo "   Auth0 Issuer: $AUTH0_ISSUER"
echo "   Auth0 Audience: $AUTH0_AUDIENCE"
echo ""
echo "📋 Important URLs:"
echo "   Debug Logs: $PUBLIC_BASE_URL/debug/logs"
echo "   Manifest: $PUBLIC_BASE_URL/manifest.json"
echo "   Health: $PUBLIC_BASE_URL/healthz"
echo ""
echo "🔍 Keep the debug logs open in your browser while testing!"
echo ""

# Start the server
npm run dev
