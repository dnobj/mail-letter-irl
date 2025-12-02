#!/bin/bash
# Install Stripe CLI on Linux (including WSL) via direct download

set -e

echo "Installing Stripe CLI..."

# Download latest release directly from GitHub
STRIPE_VERSION="1.21.0"
DOWNLOAD_URL="https://github.com/stripe/stripe-cli/releases/download/v${STRIPE_VERSION}/stripe_${STRIPE_VERSION}_linux_x86_64.tar.gz"

echo "Downloading Stripe CLI v${STRIPE_VERSION}..."
curl -L -o /tmp/stripe-cli.tar.gz "$DOWNLOAD_URL"

echo "Extracting..."
tar -xzf /tmp/stripe-cli.tar.gz -C /tmp

echo "Installing to /usr/local/bin..."
sudo mv /tmp/stripe /usr/local/bin/stripe
sudo chmod +x /usr/local/bin/stripe

# Cleanup
rm /tmp/stripe-cli.tar.gz

echo ""
echo "✓ Stripe CLI installed!"
stripe --version
echo ""
echo "Next step: run 'stripe login' to authenticate"
