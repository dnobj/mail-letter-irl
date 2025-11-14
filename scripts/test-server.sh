#!/bin/bash

echo "Testing Letter IRL MCP Server..."
echo ""

echo "1. Health check:"
curl -s http://localhost:8788/healthz
echo ""
echo ""

echo "2. Root endpoint:"
curl -s http://localhost:8788/
echo ""
echo ""

echo "3. OAuth Discovery:"
curl -s http://localhost:8788/.well-known/oauth-authorization-server | jq -r '.issuer, .authorization_endpoint'
echo ""

echo "4. Manifest:"
curl -s http://localhost:8788/manifest.json | jq -r '.name, .version'
echo ""

echo "✅ All endpoints responding!"
