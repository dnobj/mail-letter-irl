#!/bin/bash
#
# Update Admin JWT Token
# Usage: ./scripts/update-admin-jwt.sh "your-jwt-token-here"
#

if [ -z "$1" ]; then
    echo "Usage: ./scripts/update-admin-jwt.sh \"your-jwt-token-here\""
    echo ""
    echo "Or paste token and press Enter:"
    read -r JWT_TOKEN
else
    JWT_TOKEN="$1"
fi

if [ -z "$JWT_TOKEN" ]; then
    echo "❌ No token provided"
    exit 1
fi

# Update .admin-jwt file
echo "$JWT_TOKEN" > .admin-jwt
echo "✅ Updated .admin-jwt"

# Update admin-token.js file
cat > admin-token.js <<EOF
// Admin JWT Token
// This file is auto-loaded by admin-panel.html
// DO NOT commit this file to git (add to .gitignore)

const ADMIN_JWT_TOKEN = "$JWT_TOKEN";
EOF

echo "✅ Updated admin-token.js"
echo ""
echo "Admin panel will auto-reload the token on next page refresh!"
