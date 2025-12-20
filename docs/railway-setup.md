# Railway Setup Guide

**Last Updated:** December 19, 2025

This guide documents the Railway configuration for Letter IRL.

---

## Overview

Letter IRL uses **two Railway environments** in a single project:

| Environment | Branch | URL | Purpose |
|-------------|--------|-----|---------|
| **production** | `master` | `letter-irl-api-production.up.railway.app` | Live production |
| **development** | `dev` | `letter-irl-api-development.up.railway.app` | Testing & development |

Each environment has its own set of environment variables pointing to isolated services.

---

## Services

Each environment contains two services:

| Service | Purpose |
|---------|---------|
| `letter-irl-api` | MCP server and REST API |
| `mail-letter-irl-website` | Next.js marketing site and dashboard |

---

## Environment Variables

### Production Environment

```env
# Auth0 - Production Tenant
LETTER_IRL_OAUTH_ISSUER=https://dev-njmdyqf8n25rqgy7.us.auth0.com/
LETTER_IRL_OAUTH_AUTH_ENDPOINT=https://dev-njmdyqf8n25rqgy7.us.auth0.com/authorize
LETTER_IRL_OAUTH_TOKEN_ENDPOINT=https://dev-njmdyqf8n25rqgy7.us.auth0.com/oauth/token
LETTER_IRL_OAUTH_JWKS_URI=https://dev-njmdyqf8n25rqgy7.us.auth0.com/.well-known/jwks.json
LETTER_IRL_OAUTH_REGISTRATION_ENDPOINT=https://dev-njmdyqf8n25rqgy7.us.auth0.com/oidc/register
LETTER_IRL_OAUTH_AUDIENCE=https://letter-irl/api

# Database - Neon Production Branch
DATABASE_URL=<production connection string>

# Stripe - Live Mode
STRIPE_SECRET_KEY=sk_live_...
STRIPE_PUBLISHABLE_KEY=pk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_STARTER=<live price ID>
STRIPE_PRICE_REGULAR=<live price ID>
STRIPE_PRICE_POWER=<live price ID>

# PostGrid - Live Mode
LETTER_PROVIDER=postgrid
LETTER_PROVIDER_API_KEY=live_sk_...
LETTER_PROVIDER_CONFIG={"mode":"live","verbose":true}

# Admin
ADMIN_ENABLED=false
```

### Development Environment

```env
# Auth0 - Development Tenant
LETTER_IRL_OAUTH_ISSUER=https://dev-ky21dxn3qmi71hjl.us.auth0.com/
LETTER_IRL_OAUTH_AUTH_ENDPOINT=https://dev-ky21dxn3qmi71hjl.us.auth0.com/authorize
LETTER_IRL_OAUTH_TOKEN_ENDPOINT=https://dev-ky21dxn3qmi71hjl.us.auth0.com/oauth/token
LETTER_IRL_OAUTH_JWKS_URI=https://dev-ky21dxn3qmi71hjl.us.auth0.com/.well-known/jwks.json
LETTER_IRL_OAUTH_REGISTRATION_ENDPOINT=https://dev-ky21dxn3qmi71hjl.us.auth0.com/oidc/register
LETTER_IRL_OAUTH_AUDIENCE=https://letter-irl/api

# Database - Neon Dev Branch
DATABASE_URL=postgresql://neondb_owner:***@ep-billowing-wave-adu9jf3h.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require

# Stripe - Sandbox/Test Mode
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_ZFEmSGoHqdpEkiDVDo18A0acj6QD4S93
STRIPE_PRICE_STARTER=price_1SZmazLHkgDI6iWLowuAfUYV
STRIPE_PRICE_REGULAR=price_1SZmb1LHkgDI6iWLMeFx3l04
STRIPE_PRICE_POWER=price_1SZmb3LHkgDI6iWLi5CEiqcl

# PostGrid - Test Mode
LETTER_PROVIDER=postgrid
LETTER_PROVIDER_API_KEY=test_sk_...
LETTER_PROVIDER_CONFIG={"mode":"test","verbose":true}

# Admin
ADMIN_ENABLED=false

# URLs (auto-set by Railway, but can override)
LETTER_IRL_PUBLIC_BASE_URL=https://letter-irl-api-development.up.railway.app
LETTER_IRL_ALLOWED_HOSTS=letter-irl-api-development.up.railway.app,localhost,127.0.0.1
LETTER_IRL_ALLOWED_ORIGINS=https://chat.openai.com,https://chatgpt.com,https://letter-irl-api-development.up.railway.app
```

---

## Creating a New Environment

Using Railway CLI:

```bash
# Login
railway login

# Link to project
railway link

# Create new environment (duplicating from existing)
railway environment new <name> --duplicate production

# Switch to environment
railway environment <name>

# Link to service
railway service link letter-irl-api

# Set variables
railway variables --set "KEY=value" --skip-deploys

# View variables
railway variables
```

---

## External Service Mapping

| Service | Production | Development |
|---------|------------|-------------|
| **Auth0** | dev-njmdyqf8n25rqgy7.us.auth0.com | dev-ky21dxn3qmi71hjl.us.auth0.com |
| **Neon** | `production` branch | `dev` branch |
| **Stripe** | Live mode | Sandbox/Test mode |
| **PostGrid** | Live mode | Test mode |

---

## Webhook Endpoints

### Stripe Webhooks

| Environment | Endpoint | Events |
|-------------|----------|--------|
| Production | `https://letter-irl-api-production.up.railway.app/webhooks/stripe` | checkout.session.completed, charge.dispute.* |
| Development | `https://letter-irl-api-development.up.railway.app/webhooks/stripe` | * (all events) |

---

## Deployment

- **Production**: Auto-deploys from `master` branch
- **Development**: Auto-deploys from `dev` branch (configure in Railway dashboard)

To configure branch tracking:
1. Go to Railway Dashboard → Project → Environment
2. Click on the service
3. Settings → Source → Branch
4. Set to appropriate branch

---

## CLI Quick Reference

```bash
# Check current environment
railway status

# List environments
railway environment

# Switch environment
railway environment production
railway environment development

# View logs
railway logs

# View variables
railway variables
railway variables --kv

# Set variables
railway variables --set "KEY=value"
railway variables --set "KEY1=value1" --set "KEY2=value2" --skip-deploys

# Redeploy
railway redeploy
```
