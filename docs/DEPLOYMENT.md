# Deployment Guide

This guide covers deploying Letter IRL to production.

## Architecture Overview

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Website       │     │   MCP Server    │     │   Admin Panel   │
│   (Vercel)      │────▶│   (Your host)   │◀────│   (Static)      │
│   letterirl.com │     │   ngrok/cloud   │     │   admin.html    │
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
- [ ] DNS configured to point to Vercel
- [ ] SSL certificate (Vercel provides automatically)

### 2. Database (Neon)
- [ ] Production database created
- [ ] Migrations run (`001_initial_schema.sql`, `002_add_provider_fields.sql`)
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

## Website Deployment (Vercel)

### 1. Connect Repository

```bash
# Install Vercel CLI
npm i -g vercel

# Link project
cd /mnt/c/letter-irl-website
vercel link
```

Or connect via Vercel Dashboard → Import Git Repository.

### 2. Configure Environment Variables

In Vercel Dashboard → Settings → Environment Variables:

```env
# Auth0
AUTH0_SECRET=<generate-new-production-secret>
AUTH0_DOMAIN=your-tenant.us.auth0.com
AUTH0_CLIENT_ID=<production-client-id>
AUTH0_CLIENT_SECRET=<production-client-secret>
APP_BASE_URL=https://letterirl.com
AUTH0_AUDIENCE=https://letter-irl/api

# Backend API
LETTER_IRL_API_URL=https://your-mcp-server-url.com

# Stripe
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_...
```

### 3. Deploy

```bash
vercel --prod
```

Or push to `main` branch for automatic deployment.

### 4. Custom Domain

1. Vercel Dashboard → Domains → Add Domain
2. Enter `letterirl.com`
3. Update DNS records as instructed
4. Wait for SSL certificate provisioning (automatic)

### 5. Update Auth0 URLs

Add production URLs to Auth0 Application:
- Callback: `https://letterirl.com/auth/callback`
- Logout: `https://letterirl.com`
- Web Origins: `https://letterirl.com`

## Backend Deployment (MCP Server)

The MCP server can be hosted on various platforms. Options:

### Option A: Persistent Server (Recommended for Production)

Deploy to a cloud VM (AWS EC2, DigitalOcean, etc.):

```bash
# Clone and setup
git clone https://github.com/dnobj/mail-letter-irl.git
cd mail-letter-irl
npm install
npm run build

# Configure environment
cp .env.example .env
# Edit .env with production values

# Run with PM2
npm install -g pm2
pm2 start npm --name "letter-irl" -- start
pm2 save
pm2 startup
```

### Option B: Cloudflare Workers

The project was designed for Workers compatibility:

```bash
npx wrangler deploy
```

Configure secrets in Cloudflare Dashboard.

### Option C: Continue with ngrok (Development Only)

Not recommended for production, but works for testing:

```bash
ngrok http 8788 --domain=your-domain.ngrok.io
```

## Environment Variables Reference

### Website (.env.local → Vercel)

| Variable | Description | Example |
|----------|-------------|---------|
| `AUTH0_SECRET` | Random 32+ char string | `openssl rand -hex 32` |
| `AUTH0_DOMAIN` | Auth0 tenant domain | `your-tenant.us.auth0.com` |
| `AUTH0_CLIENT_ID` | Website app client ID | `abc123...` |
| `AUTH0_CLIENT_SECRET` | Website app secret | `xyz789...` |
| `APP_BASE_URL` | Website URL | `https://letterirl.com` |
| `AUTH0_AUDIENCE` | API audience | `https://letter-irl/api` |
| `LETTER_IRL_API_URL` | Backend API URL | `https://api.letterirl.com` |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Stripe public key | `pk_live_...` |

### Backend (.env)

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | Neon connection string | `postgres://...@ep-xxx.us-east-2.aws.neon.tech/neondb` |
| `AUTH0_DOMAIN` | Auth0 tenant domain | `your-tenant.us.auth0.com` |
| `AUTH0_AUDIENCE` | API audience | `https://letter-irl/api` |
| `AUTH0_CLIENT_ID` | MCP app client ID | `def456...` |
| `AUTH0_CLIENT_SECRET` | MCP app secret | `uvw123...` |
| `POSTGRID_API_KEY` | PostGrid API key | `live_sk_...` |
| `STRIPE_SECRET_KEY` | Stripe secret key | `sk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook secret | `whsec_...` |
| `ADMIN_JWT_SECRET` | Admin panel JWT secret | `<random-string>` |

## Post-Deployment Verification

### 1. Website Health Check

- [ ] Homepage loads
- [ ] Auth0 login works
- [ ] Dashboard accessible after login
- [ ] Credit balance displays
- [ ] Letter history displays

### 2. Backend Health Check

- [ ] `/health` endpoint returns 200
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

### Recommended Tools

1. **Vercel Analytics** - Built-in for website
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

### Website (Vercel)

```bash
# List deployments
vercel ls

# Rollback to previous
vercel rollback <deployment-url>
```

Or use Vercel Dashboard → Deployments → Promote previous deployment.

### Backend

```bash
# If using PM2
pm2 stop letter-irl
git checkout <previous-commit>
npm install
npm run build
pm2 start letter-irl
```

## Security Checklist

- [ ] All secrets in environment variables (not in code)
- [ ] HTTPS enforced on all endpoints
- [ ] CORS configured for allowed origins only
- [ ] Rate limiting enabled
- [ ] Database credentials rotated from development
- [ ] Admin JWT secret is unique
- [ ] Stripe webhook signature verification enabled
