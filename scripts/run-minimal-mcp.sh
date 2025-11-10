#!/usr/bin/env bash
set -euo pipefail

export MINIMAL_MCP_HOST="0.0.0.0"
export MINIMAL_MCP_PORT="8091"
export MINIMAL_PUBLIC_BASE="https://amitotically-gubernacular-elise.ngrok-free.dev"
export MINIMAL_OAUTH_ISSUER="https://dev-ky21dxn3qmi71hjl.us.auth0.com/"
export MINIMAL_OAUTH_AUTH="https://dev-ky21dxn3qmi71hjl.us.auth0.com/authorize"
export MINIMAL_OAUTH_TOKEN="https://dev-ky21dxn3qmi71hjl.us.auth0.com/oauth/token"
export MINIMAL_OAUTH_JWKS="https://dev-ky21dxn3qmi71hjl.us.auth0.com/.well-known/jwks.json"
export MINIMAL_OAUTH_REGISTRATION="https://dev-ky21dxn3qmi71hjl.us.auth0.com/oauth/register"

npx tsx test/minimalServer.ts
