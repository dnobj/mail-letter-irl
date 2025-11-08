#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID=${PROJECT_ID:-mail-letter-irl}
PUBLIC_BASE_URL=${LETTER_IRL_PUBLIC_BASE_URL:-"https://amitotically-gubernacular-elise.ngrok-free.dev"}

if [[ -t 0 ]]; then
  read -r -p "OAuth Client ID: " CLIENT_ID
  read -r -p "OAuth Client Secret (optional for reference): " CLIENT_SECRET || true
else
  if [[ -z "${CLIENT_ID:-}" ]]; then
    echo "CLIENT_ID environment variable must be set when running non-interactively" >&2
    exit 1
  fi
  CLIENT_SECRET=${CLIENT_SECRET:-}
fi

cat <<ENVVARS
export LETTER_IRL_OAUTH_ISSUER="https://securetoken.google.com/${PROJECT_ID}"
export LETTER_IRL_OAUTH_JWKS_URI="https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
export LETTER_IRL_OAUTH_AUTH_ENDPOINT="https://accounts.google.com/o/oauth2/v2/auth"
export LETTER_IRL_OAUTH_TOKEN_ENDPOINT="https://oauth2.googleapis.com/token"
export LETTER_IRL_OAUTH_SCOPES="openid email profile"
export LETTER_IRL_OAUTH_AUDIENCE="${CLIENT_ID}"
export LETTER_IRL_OAUTH_CLIENT_ID="${CLIENT_ID}"
export LETTER_IRL_PUBLIC_BASE_URL="${PUBLIC_BASE_URL}"
export LETTER_IRL_OAUTH_CLIENT_SECRET="${CLIENT_SECRET}"
ENVVARS
