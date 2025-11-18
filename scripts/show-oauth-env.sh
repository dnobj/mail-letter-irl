#!/usr/bin/env sh

for key in \
  LETTER_IRL_OAUTH_ISSUER \
  LETTER_IRL_OAUTH_AUTH_ENDPOINT \
  LETTER_IRL_OAUTH_TOKEN_ENDPOINT \
  LETTER_IRL_OAUTH_JWKS_URI \
  LETTER_IRL_OAUTH_REGISTRATION_ENDPOINT \
  LETTER_IRL_OAUTH_SCOPES \
  LETTER_IRL_OAUTH_AUDIENCE
  do
    value=$(printenv "$key")
    if [ -z "$value" ]; then
      echo "$key=<UNSET>"
    else
      echo "$key=$value"
    fi
  done
