#!/usr/bin/env bash
set -euo pipefail

export LETTER_IRL_HTTP_HOST="0.0.0.0"
export LETTER_IRL_ALLOWED_HOSTS="amitotically-gubernacular-elise.ngrok-free.dev,amitotically-gubernacular-elise.ngrok-free.dev:443,localhost,127.0.0.1"
export LETTER_IRL_ALLOWED_ORIGINS="https://chat.openai.com,https://chatgpt.com,https://amitotically-gubernacular-elise.ngrok-free.dev"
export LETTER_IRL_DEFAULT_ORIGIN="https://chat.openai.com"

# OAuth metadata required by ChatGPT connectors
export LETTER_IRL_OAUTH_ISSUER="https://dev-ky21dxn3qmi71hjl.us.auth0.com/"
export LETTER_IRL_OAUTH_AUTH_ENDPOINT="https://dev-ky21dxn3qmi71hjl.us.auth0.com/authorize"
export LETTER_IRL_OAUTH_TOKEN_ENDPOINT="https://dev-ky21dxn3qmi71hjl.us.auth0.com/oauth/token"
export LETTER_IRL_OAUTH_JWKS_URI="https://dev-ky21dxn3qmi71hjl.us.auth0.com/.well-known/jwks.json"
export LETTER_IRL_OAUTH_REGISTRATION_ENDPOINT="https://dev-ky21dxn3qmi71hjl.us.auth0.com/oauth/register"
export LETTER_IRL_OAUTH_SCOPES="openid email profile"
export LETTER_IRL_OAUTH_AUDIENCE="https://letter-irl/api"

# Optional static client fields for /oauth/register if needed later
# export LETTER_IRL_OAUTH_CLIENT_ID="..."
# export LETTER_IRL_OAUTH_CLIENT_SECRET="..."

echo "Using OAuth issuer: ${LETTER_IRL_OAUTH_ISSUER:-unset}"

echo "Starting Letter IRL MCP HTTP server..."
npm run mcp:http | tee logs/mcp-http.log
