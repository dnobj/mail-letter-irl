#!/usr/bin/env bash
set -euo pipefail

export LETTER_IRL_HTTP_HOST="0.0.0.0"
export LETTER_IRL_ALLOWED_HOSTS="amitotically-gubernacular-elise.ngrok-free.dev,amitotically-gubernacular-elise.ngrok-free.dev:443,localhost,127.0.0.1"
export LETTER_IRL_ALLOWED_ORIGINS="https://chat.openai.com,https://chatgpt.com,https://amitotically-gubernacular-elise.ngrok-free.dev"
export LETTER_IRL_DEFAULT_ORIGIN="https://chat.openai.com"

npm run mcp:http | tee logs/mcp-http.log
