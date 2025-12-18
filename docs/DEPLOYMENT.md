# Deployment Guide

This guide covers deploying Letter IRL to both production and development environments using Railway.

## Architecture Overview

### Production Environment

```
┌─────────────────┐     ┌─────────────────────────┐     ┌─────────────────┐
│   Website       │     │   MCP Server            │     │   Admin Panel   │
│   (Railway)     │────▶│   (Railway)             │◀────│   (Local only)  │
│   letterirl.com │     │ api.letterirl.com       │     │   admin.html    │
│   Branch:master │     │   Branch: master        │     └─────────────────┘
└─────────────────┘     └────────┬────────────────┘
                                │
        ┌────────────────────────┼────────────────────────┐
        ▼                        ▼                        ▼
┌───────────────┐      ┌─────────────────┐      ┌─────────────────┐
│   Neon        │      │   Auth0         │      │   PostGrid      │
│   (main)      │      │   (prod tenant) │      │   (live mode)   │
└───────────────┘      └─────────────────┘      └─────────────────┘
                                                         │
                                                         ▼
                                                ┌─────────────────┐
                                                │   Stripe        │
                                                │   (live mode)   │
                                                └─────────────────┘
```

### Development Environment

```
┌─────────────────┐     ┌─────────────────────────┐     ┌─────────────────┐
│   Website       │     │   MCP Server            │     │   Admin Panel   │
│   (Railway)     │────▶│   (Railway)             │◀────│   (Local only)  │
│   obscure URL   │     │   obscure URL           │     │   admin.html    │
│   Branch: dev   │     │   Branch: dev           │     └─────────────────┘
└─────────────────┘     └────────┬────────────────┘
                                │
        ┌────────────────────────┼────────────────────────┐
        ▼                        ▼                        ▼
┌───────────────┐      ┌─────────────────┐      ┌─────────────────┐
│   Neon        │      │   Auth0         │      │   PostGrid      │
│   (dev branch)│      │   (dev tenant)  │      │   (dummy mode)  │
└───────────────┘      └─────────────────┘      └─────────────────┘
                                                         │
                                                         ▼
                                                ┌─────────────────┐
                                                │   Stripe        │
                                                │   (test mode)   │
                                                └─────────────────┘
```

## Environment Strategy

Letter IRL uses a **dual-environment deployment strategy**:

| Environment | Git Branch | Railway Deployment | Purpose |
|-------------|------------|--------------------|---------|
| **Production** | `master` | api.letterirl.com | Live users and data |
| **Development** | `dev` | Obscure URL | Isolated testing with production-like data |

### Git Branching Workflow

```
master (production)
  ↑
  └── dev (development)
        ↑
        ├── feature/add-email-notifications
        ├── feature/improve-address-validation
        └── feature/user-dashboard-redesign
```

- Features branch from `dev`
- Features merge to `dev` via pull request
- `dev` merges to `master` for production releases
- Railway auto-deploys on push to either branch

## Pre-Deployment Checklist

### Production Environment

#### 1. Domain Setup
- [ ] Domain registered (letterirl.com)
- [ ] DNS configured to point to Railway
- [ ] SSL certificate (Railway provides automatically)

#### 2. Database (Neon)
- [ ] Production database created (main branch)
- [ ] Migrations run (`npm run db:migrate`)
- [ ] Connection pooling enabled (recommended)
- [ ] Backup schedule configured

#### 3. Auth0 Production
- [ ] Production tenant: `dev-ky21dxn3qmi71hjl.us.auth0.com`
- [ ] Update callback URLs for production domain
- [ ] Enable production connections (Google, etc.)
- [ ] Configure API audience

#### 4. Stripe Production
- [ ] Switch from sandbox to live mode
- [ ] Update API keys (sk_live_...)
- [ ] Configure webhook endpoint for production URL
- [ ] Test payment flow

#### 5. PostGrid Production
- [ ] Switch from test to live API key (live_sk_...)
- [ ] Verify address validation works
- [ ] Test letter sending (costs real money!)

### Development Environment

#### 1. Database (Neon)
- [ ] Development branch created: `dev`
- [ ] Initial sync from production: `npm run dev:sync`
- [ ] Migrations tested on dev branch

#### 2. Auth0 Development
- [ ] Development tenant created: `letter-irl-dev.us.auth0.com`
- [ ] Applications configured (MCP, Website)
- [ ] Social connections enabled (Google, GitHub, etc.)
- [ ] Callback URLs configured for dev Railway URL
- [ ] Username-Password users synced via `npm run dev:sync`

#### 3. Stripe Development
- [ ] Test mode API keys (sk_test_...)
- [ ] Webhook endpoint configured for dev Railway URL
- [ ] Test cards documented

#### 4. PostGrid Development
- [ ] Dummy provider configured (no API key needed)
- [ ] Letter flow tested without real mail

#### 5. Railway Development
- [ ] Separate Railway project for development
- [ ] Auto-deploy from `dev` branch configured
- [ ] Environment variables configured for dev services

## Railway Deployment

### Overview

Railway is configured for **dual-environment deployment**:
- Production project deploys from `master` branch
- Development project deploys from `dev` branch

### 1. Create Railway Projects

1. Go to [railway.app](https://railway.app)
2. Create two separate projects:
   - `letter-irl-production`
   - `letter-irl-development`
3. Connect GitHub repository to each
4. Configure branch filters

### 2. Deploy Backend to Production

**Railway Project**: `letter-irl-production`
**Git Branch**: `master`
**Domain**: api.letterirl.com

**Environment Variables** (Railway Dashboard → Variables):

```env
# Database
DATABASE_URL=postgres://...@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require

# Auth0 (Production Tenant)
LETTER_IRL_OAUTH_JWKS_URI=https://dev-ky21dxn3qmi71hjl.us.auth0.com/.well-known/jwks.json
LETTER_IRL_OAUTH_ISSUER=https://dev-ky21dxn3qmi71hjl.us.auth0.com/
LETTER_IRL_OAUTH_AUDIENCE=https://letter-irl/api

# PostGrid (Live Mode)
POSTGRID_API_KEY=live_sk_...
ACTIVE_LETTER_PROVIDER=postgrid

# Stripe (Live Mode)
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Server Config
LETTER_IRL_PUBLIC_BASE_URL=https://api.letterirl.com
LETTER_IRL_ALLOWED_ORIGINS=https://letterirl.com,https://chatgpt.com,https://chat.openai.com
ADMIN_ENABLED=false
```

### 3. Deploy Backend to Development

**Railway Project**: `letter-irl-development`
**Git Branch**: `dev`
**Domain**: Auto-generated obscure URL (e.g., `letter-irl-dev-production-xyz.up.railway.app`)

**Environment Variables** (Railway Dashboard → Variables):

```env
# Database (Dev Branch)
DATABASE_URL=postgres://...@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require&options=branch%3Ddev

# Auth0 (Development Tenant)
LETTER_IRL_OAUTH_JWKS_URI=https://letter-irl-dev.us.auth0.com/.well-known/jwks.json
LETTER_IRL_OAUTH_ISSUER=https://letter-irl-dev.us.auth0.com/
LETTER_IRL_OAUTH_AUDIENCE=https://letter-irl/api

# PostGrid (Dummy Provider)
ACTIVE_LETTER_PROVIDER=dummy

# Stripe (Test Mode)
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Server Config
LETTER_IRL_PUBLIC_BASE_URL=https://<your-dev-url>.up.railway.app
LETTER_IRL_ALLOWED_ORIGINS=https://<your-dev-website-url>.up.railway.app,https://chatgpt.com
ADMIN_ENABLED=false
```

**Note**: No custom domain for development. Use auto-generated URL.

### 4. Deploy Website to Production

**Railway Project**: `letter-irl-website-production`
**Git Branch**: `master`
**Domain**: letterirl.com

**Environment Variables**:

```env
# Auth0 (Production Tenant)
AUTH0_SECRET=<generate-with-openssl-rand-hex-32>
AUTH0_BASE_URL=https://letterirl.com
AUTH0_ISSUER_BASE_URL=https://dev-ky21dxn3qmi71hjl.us.auth0.com
AUTH0_CLIENT_ID=<website-client-id>
AUTH0_CLIENT_SECRET=<website-client-secret>
AUTH0_AUDIENCE=https://letter-irl/api

# Backend API
NEXT_PUBLIC_LETTER_IRL_API_URL=https://api.letterirl.com

# Stripe (Live Mode)
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_...
```

### 5. Deploy Website to Development

**Railway Project**: `letter-irl-website-development`
**Git Branch**: `dev`
**Domain**: Auto-generated obscure URL

**Environment Variables**:

```env
# Auth0 (Development Tenant)
AUTH0_SECRET=<generate-with-openssl-rand-hex-32>
AUTH0_BASE_URL=https://<your-dev-website-url>.up.railway.app
AUTH0_ISSUER_BASE_URL=https://letter-irl-dev.us.auth0.com
AUTH0_CLIENT_ID=<dev-website-client-id>
AUTH0_CLIENT_SECRET=<dev-website-client-secret>
AUTH0_AUDIENCE=https://letter-irl/api

# Backend API
NEXT_PUBLIC_LETTER_IRL_API_URL=https://<your-dev-backend-url>.up.railway.app

# Stripe (Test Mode)
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...
```

### 6. Update Auth0 URLs

#### Production Tenant

Add production URLs to Auth0 Application:
- Callback: `https://letterirl.com/auth/callback`
- Logout: `https://letterirl.com`
- Web Origins: `https://letterirl.com`

#### Development Tenant

Add development URLs to Auth0 Application:
- Callback: `https://<your-dev-website-url>.up.railway.app/auth/callback`
- Logout: `https://<your-dev-website-url>.up.railway.app`
- Web Origins: `https://<your-dev-website-url>.up.railway.app`

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

## Development Workflow

### Daily Development

1. **Create feature branch** from `dev`:
   ```bash
   git checkout dev
   git pull origin dev
   git checkout -b feature/my-feature
   ```

2. **Make changes** and test locally

3. **Push to feature branch** and create PR to `dev`:
   ```bash
   git push origin feature/my-feature
   # Create PR: feature/my-feature → dev
   ```

4. **Merge to dev** → Railway auto-deploys to development environment

5. **Test in development environment** with real Auth0/Stripe/Neon setup

6. **When ready for production**, create PR: `dev → master`

7. **Merge to master** → Railway auto-deploys to production

### Database Sync

Sync production data to development periodically:

```bash
npm run dev:sync
```

This command:
- Deletes and recreates Neon `dev` branch from `main`
- Exports Username-Password users from production Auth0
- Imports users to development Auth0 (preserves user IDs)

## Post-Deployment Verification

### Production Environment

#### 1. Website Health Check

- [ ] Homepage loads (letterirl.com)
- [ ] Auth0 login works (production tenant)
- [ ] Dashboard accessible after login
- [ ] Credit balance displays
- [ ] Letter history displays

#### 2. Backend Health Check

- [ ] `/healthz` endpoint returns 200 (api.letterirl.com/healthz)
- [ ] MCP tools respond in ChatGPT
- [ ] Database queries work (main branch)

#### 3. Payment Flow

- [ ] Stripe checkout opens (live mode)
- [ ] Test purchase completes with real card
- [ ] Credits added to account
- [ ] Transaction recorded

#### 4. Letter Sending

- [ ] Create letter via ChatGPT
- [ ] Letter shows in dashboard
- [ ] PostGrid receives order (live mode - costs money!)
- [ ] Status updates work

### Development Environment

#### 1. Website Health Check

- [ ] Homepage loads (dev Railway URL)
- [ ] Auth0 login works (development tenant)
- [ ] Dashboard accessible after login
- [ ] Credit balance displays
- [ ] Letter history displays

#### 2. Backend Health Check

- [ ] `/healthz` endpoint returns 200 (dev Railway URL)
- [ ] MCP tools respond in ChatGPT (using dev URL)
- [ ] Database queries work (dev branch)

#### 3. Payment Flow

- [ ] Stripe checkout opens (test mode)
- [ ] Test purchase completes with test card (4242 4242 4242 4242)
- [ ] Credits added to account
- [ ] Transaction recorded

#### 4. Letter Sending

- [ ] Create letter via ChatGPT (dev MCP URL)
- [ ] Letter shows in dashboard
- [ ] Dummy provider simulates success (no real mail sent)
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

### Production

- [ ] All secrets in environment variables (not in code)
- [ ] HTTPS enforced on all endpoints
- [ ] CORS configured for allowed origins only (letterirl.com, chatgpt.com)
- [ ] Rate limiting enabled
- [ ] Database credentials use production (main branch)
- [ ] Stripe webhook signature verification enabled (live mode)
- [ ] PostGrid uses live API key (costs real money)
- [ ] Admin panel disabled (ADMIN_ENABLED=false)

### Development

- [ ] All secrets in environment variables (not in code)
- [ ] HTTPS enforced on all endpoints
- [ ] CORS configured for dev origins
- [ ] Rate limiting enabled
- [ ] Database credentials use dev branch
- [ ] Stripe webhook signature verification enabled (test mode)
- [ ] PostGrid uses dummy provider (no real mail)
- [ ] Admin panel disabled (ADMIN_ENABLED=false)
- [ ] Development Auth0 tenant isolated from production

## Troubleshooting

### Development Environment Issues

#### Database Connection Failed
- Verify Neon dev branch exists: `npm run dev:sync`
- Check DATABASE_URL has `options=branch%3Ddev` parameter

#### Auth0 Login Failed
- Verify callback URLs match Railway dev URL
- Check Auth0 tenant is development tenant (letter-irl-dev.us.auth0.com)
- Verify social connections are enabled in dev tenant

#### User IDs Don't Match
- Run `npm run dev:sync` to import Username-Password users
- Social login IDs should automatically match

#### Stripe Checkout Fails
- Verify using test mode API key (sk_test_...)
- Use test card: 4242 4242 4242 4242

#### Letters Not Sending
- Verify ACTIVE_LETTER_PROVIDER=dummy in dev environment
- Check logs for dummy provider simulation output

### Railway Deployment Issues

#### Wrong Branch Deploying
- Check Railway project branch filter configuration
- Verify GitHub webhook is triggering correct Railway project

#### Environment Variables Missing
- Compare against this guide's environment variable lists
- Ensure all required variables are set in Railway dashboard
