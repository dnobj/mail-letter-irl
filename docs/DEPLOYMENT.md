# Deployment Guide

This guide covers deploying Letter IRL to production using Railway.

## Architecture Overview

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Website       │     │   MCP Server    │     │   Admin Panel   │
│   (Railway)     │────▶│   (Railway)     │◀────│   (Local only)  │
│   letterirl.com │     │ api.letterirl   │     │   admin.html    │
└─────────────────┘     └────────┬────────┘     └─────────────────┘
                                │
        ┌────────────────────────┼────────────────────────┐
        ▼                        ▼                        ▼
┌───────────────┐      ┌─────────────────┐      ┌─────────────────┐
│   Neon        │      │   Auth0         │      │   PostGrid      │
│   PostgreSQL  │      │   (Auth)        │      │   (Mail API)    │
└───────────────┘      └─────────────────┘      └─────────────────┘
                                                         │
                                                         ▼
                                                ┌─────────────────┐
                                                │   Stripe        │
                                                │   (Payments)    │
                                                └─────────────────┘
```

## Pre-Deployment Checklist

### 1. Domain Setup
- [ ] Domain registered (letterirl.com)
- [ ] DNS configured to point to Railway
- [ ] SSL certificate (Railway provides automatically)

### 2. Database (Neon)
- [ ] Production database created
- [ ] Migrations run (`npm run db:migrate`)
- [ ] Connection pooling enabled (recommended)
- [ ] Backup schedule configured

### 3. Auth0 Production
- [ ] Production tenant or separate production application
- [ ] Update callback URLs for production domain
- [ ] Enable production connections (Google, etc.)
- [ ] Configure API audience

### 4. Stripe Production
- [ ] Switch from sandbox to live mode
- [ ] Update API keys
- [ ] Configure webhook endpoint for production URL
- [ ] Test payment flow

### 5. PostGrid Production
- [ ] Switch from test to live API key
- [ ] Verify address validation works
- [ ] Test letter sending (costs real money!)

## Railway Deployment

### 1. Create Railway Project

1. Go to [railway.app](https://railway.app)
2. Create new project
3. Connect GitHub repository

### 2. Deploy Backend (MCP Server)

```bash
# Repository: mail-letter-irl
```

**Environment Variables** (Railway Dashboard → Variables):

```env
# Database
DATABASE_URL=postgres://...@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require

# Auth0
LETTER_IRL_OAUTH_JWKS_URI=https://your-tenant.us.auth0.com/.well-known/jwks.json
LETTER_IRL_OAUTH_ISSUER=https://your-tenant.us.auth0.com/
LETTER_IRL_OAUTH_AUDIENCE=https://letter-irl/api

# PostGrid
POSTGRID_API_KEY=live_sk_...

# Stripe
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Server Config
LETTER_IRL_PUBLIC_BASE_URL=https://api.letterirl.com
LETTER_IRL_ALLOWED_ORIGINS=https://letterirl.com,https://chatgpt.com,https://chat.openai.com
```

**Custom Domain**: api.letterirl.com

### 3. Deploy Website (Next.js)

```bash
# Repository: mail-letter-irl-website
```

**Environment Variables**:

```env
# Auth0
AUTH0_SECRET=<generate-with-openssl-rand-hex-32>
AUTH0_BASE_URL=https://letterirl.com
AUTH0_ISSUER_BASE_URL=https://your-tenant.us.auth0.com
AUTH0_CLIENT_ID=<website-client-id>
AUTH0_CLIENT_SECRET=<website-client-secret>
AUTH0_AUDIENCE=https://letter-irl/api

# Backend API
NEXT_PUBLIC_LETTER_IRL_API_URL=https://api.letterirl.com

# Stripe
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_...
```

**Custom Domain**: letterirl.com

### 4. Update Auth0 URLs

Add production URLs to Auth0 Application:
- Callback: `https://letterirl.com/auth/callback`
- Logout: `https://letterirl.com`
- Web Origins: `https://letterirl.com`

## Environment Variables Reference

### Backend (.env)

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | Neon connection string | `postgres://...@ep-xxx.us-east-2.aws.neon.tech/neondb` |
| `LETTER_IRL_OAUTH_JWKS_URI` | Auth0 JWKS endpoint | `https://tenant.us.auth0.com/.well-known/jwks.json` |
| `LETTER_IRL_OAUTH_ISSUER` | Auth0 issuer URL | `https://tenant.us.auth0.com/` |
| `LETTER_IRL_OAUTH_AUDIENCE` | API audience | `https://letter-irl/api` |
| `POSTGRID_API_KEY` | PostGrid API key | `live_sk_...` |
| `STRIPE_SECRET_KEY` | Stripe secret key | `sk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook secret | `whsec_...` |

### Website (.env)

| Variable | Description | Example |
|----------|-------------|---------|
| `AUTH0_SECRET` | Random 32+ char string | `openssl rand -hex 32` |
| `AUTH0_BASE_URL` | Website URL | `https://letterirl.com` |
| `AUTH0_ISSUER_BASE_URL` | Auth0 tenant URL | `https://tenant.us.auth0.com` |
| `AUTH0_CLIENT_ID` | Website app client ID | `abc123...` |
| `AUTH0_CLIENT_SECRET` | Website app secret | `xyz789...` |
| `AUTH0_AUDIENCE` | API audience | `https://letter-irl/api` |
| `NEXT_PUBLIC_LETTER_IRL_API_URL` | Backend API URL | `https://api.letterirl.com` |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Stripe public key | `pk_live_...` |

## Post-Deployment Verification

### 1. Website Health Check

- [ ] Homepage loads
- [ ] Auth0 login works
- [ ] Dashboard accessible after login
- [ ] Credit balance displays
- [ ] Letter history displays

### 2. Backend Health Check

- [ ] `/healthz` endpoint returns 200
- [ ] MCP tools respond in ChatGPT
- [ ] Database queries work

### 3. Payment Flow

- [ ] Stripe checkout opens
- [ ] Test purchase completes
- [ ] Credits added to account
- [ ] Transaction recorded

### 4. Letter Sending

- [ ] Create letter via ChatGPT
- [ ] Letter shows in dashboard
- [ ] PostGrid receives order
- [ ] Status updates work

## Monitoring

### Railway Dashboard

- View logs in real-time
- Monitor resource usage
- Set up alerts

### Other Tools

1. **Railway Metrics** - Built-in CPU/memory monitoring
2. **Sentry** - Error tracking (add to both projects)
3. **Neon Dashboard** - Database metrics
4. **PostGrid Dashboard** - Mail tracking

### Key Metrics to Watch

- Error rates
- API response times
- Database connection pool usage
- Credit balance changes
- Letter send success rate

## Rollback Procedure

### Railway

1. Go to Railway Dashboard → Deployments
2. Click on previous successful deployment
3. Click "Rollback to this deployment"

Or via CLI:

```bash
railway rollback
```

## Security Checklist

- [ ] All secrets in environment variables (not in code)
- [ ] HTTPS enforced on all endpoints
- [ ] CORS configured for allowed origins only
- [ ] Rate limiting enabled
- [ ] Database credentials rotated from development
- [ ] Stripe webhook signature verification enabled
- [ ] Admin panel only accessible locally (ADMIN_ENABLED=false on Railway)
