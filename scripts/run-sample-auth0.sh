#!/usr/bin/env bash
set -euo pipefail

export SAMPLE_HOST="0.0.0.0"
export SAMPLE_PORT="8092"
export SAMPLE_PUBLIC_BASE="https://amitotically-gubernacular-elise.ngrok-free.dev"
export SAMPLE_ISSUER="https://dev-ky21dxn3qmi71hjl.us.auth0.com/"
export SAMPLE_AUTH="https://dev-ky21dxn3qmi71hjl.us.auth0.com/authorize"
export SAMPLE_TOKEN="https://dev-ky21dxn3qmi71hjl.us.auth0.com/oauth/token"
export SAMPLE_JWKS="https://dev-ky21dxn3qmi71hjl.us.auth0.com/.well-known/jwks.json"
export SAMPLE_REGISTRATION="https://dev-ky21dxn3qmi71hjl.us.auth0.com/oauth/register"

npx tsx test/auth0-sample/server.ts
