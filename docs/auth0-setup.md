# Auth0 Setup Guide

**Last Updated:** July 23, 2026

This guide documents the complete Auth0 configuration for Letter IRL.

## Current MCP OAuth architecture

ChatGPT uses a separate manually imported Auth0 **CIMD application** in each
environment: authorization code, PKCE S256, and the client authentication
method the CIMD document declares - currently `private_key_jwt`, verified on the
production import 2026-09-05. Its client ID is the OpenAI-hosted HTTPS CIMD
URL. The dedicated Auth0 MCP API identifier exactly equals that
environment's canonical `/mcp` resource and grants only `mail:read`,
`mail:draft`, and `mail:send`. The website/REST audience is unchanged.

CIMD and the resource-parameter compatibility profile are owner-managed tenant
settings. DCR and Letter IRL's static `/oauth/register` shim are not the target
architecture; they may be enabled only as the documented environment-specific
rollback. Claude/PAT clients do not share the ChatGPT application. Auth0
Enterprise is out of scope; `private_key_jwt` is not - it is what ChatGPT's CIMD
document declares, and Auth0 takes the document's declared method as given. See
the corrected contract header in `docs/auth0-tenant-configuration.md`.

---

## Overview

Letter IRL uses **two separate Auth0 tenants** for complete isolation between production and development:

| Environment | Tenant Domain | Account Email |
|-------------|---------------|---------------|
| **Production** | `dev-njmdyqf8n25rqgy7.us.auth0.com` | dnicholl@letterirl.com |
| **Development** | `dev-ky21dxn3qmi71hjl.us.auth0.com` | dnicholl@objective.works |

Each tenant has the same applications configured:

| Application | Type | Purpose |
|-------------|------|---------|
| Letter IRL Website | Regular Web App | User dashboard login (Next.js + `@auth0/nextjs-auth0`) |
| ChatGPT MCP | Public CIMD application | ChatGPT authentication only |

### User ID Strategy

Social login user IDs (Google, GitHub, etc.) are **identical across tenants** because the ID comes from the provider. Only Username-Password users (`auth0|xxx`) have tenant-specific IDs and require sync/import.

---

## Tenant Setup

### 1. Create Auth0 Account

1. Go to [auth0.com](https://auth0.com)
2. Sign up with your email (e.g., `dnicholl@letterirl.com`)
3. Create a new tenant

### 2. Tenant Configuration

| Setting | Production Value |
|---------|------------------|
| Tenant Domain | `dev-njmdyqf8n25rqgy7.us.auth0.com` |
| Region | US |
| Environment Tag | **Production** (change from Development) |

**To change Environment Tag:**
1. Go to Settings (gear icon) → General
2. Scroll to "Assign Environment Tag"
3. Select **Production**
4. Save

---

## Applications

### Application 1: Letter IRL Website

**Purpose:** User authentication for the Next.js dashboard

**Setup Steps:**
1. In Auth0 Dashboard → Applications → Create Application
2. **Name:** `Letter IRL Website`
3. **Technology:** Next.js
4. **Type:** Regular Web App
5. Click "Create Application"

**Configuration (after creation):**

| Setting | Value |
|---------|-------|
| Client ID | `wX17u1wOn3XJRVba1ejIappBNpDno3ER` |
| Description | `User dashboard for Letter IRL - view credits, letter history, and manage your account.` |
| Application Login URI | `https://letterirl.com/auth/login` |
| Allowed Callback URLs | `https://letterirl.com/auth/callback` |
| Allowed Logout URLs | `https://letterirl.com` |
| Allowed Web Origins | `https://letterirl.com` |

**Note:** The website uses Auth0 SDK v4 with `auth0.middleware()` in `proxy.ts`. Auth routes are automatically handled at `/auth/*` (login, callback, logout, me).

**Environment Variables for Website:**
```env
AUTH0_SECRET=<generate with `openssl rand -hex 32`>
AUTH0_BASE_URL=https://letterirl.com
AUTH0_ISSUER_BASE_URL=https://dev-njmdyqf8n25rqgy7.us.auth0.com
AUTH0_CLIENT_ID=wX17u1wOn3XJRVba1ejIappBNpDno3ER
AUTH0_CLIENT_SECRET=<from application settings - click eye icon to reveal>
AUTH0_AUDIENCE=https://letter-irl/api
```

---

### Application 2: M2M for Sync Script (Optional)

**Purpose:** Management API access for the dev sync script

**Setup Steps:**
1. Applications → Create Application
2. **Name:** `Dev Sync Script`
3. **Type:** Machine to Machine
4. **Authorized API:** Auth0 Management API
5. **Permissions:** `read:users`, `create:users`, `delete:users`

---

## API (Resource Server)

**Purpose:** Define the API that the MCP server protects

**Setup Steps:**
1. Applications → APIs → Create API
2. **Name:** `Letter IRL API`
3. **Identifier:** `https://letter-irl/api`
4. **Signing Algorithm:** RS256

**Settings:**
| Setting | Value |
|---------|-------|
| RBAC | Disabled (not using roles) |
| Allow Skipping User Consent | Enabled (first-party apps) |

---

## Legacy DCR rollback (normally disabled)

**Purpose:** Restore the pre-CIMD DEV baseline only during a controlled rollback.

**Setup Steps:**
1. Go to Settings (gear icon) → Advanced
2. Find "Dynamic Client Registration (DCR)"
3. Enable the toggle only when the rollback owner approves it
4. Save
5. Set `LETTER_IRL_OAUTH_STATIC_DCR_COMPATIBILITY=true`,
   `CHATGPT_STATIC_CLIENT_ID` to the inventoried rollback client, and
   `CHATGPT_STATIC_REDIRECT_URIS` to the space-separated exact callback URLs
   already configured on that Auth0 client. Never use a wildcard or infer a
   per-app callback.
6. Verify protected-resource discovery names the Letter IRL origin as the
   authorization server, its authorization metadata advertises
   `/oauth/register`, and the registration response returns the exact callback
   inventory.

---

## Connections for strict third-party CIMD applications

**Purpose:** Ensure the manually imported strict third-party ChatGPT application
has eligible identity connections without coupling it to Claude/PAT.

**Solution:** Audit domain-level eligibility and enable only the connections the
imported CIMD application requires.

**Setup Steps:**

### For Google Connection:
1. Go to **Authentication → Social → google-oauth2**
2. Scroll to the bottom of the settings
3. Find the **"Domain"** toggle
4. **Enable** it
5. Save

### For Username-Password Connection:
1. Go to **Authentication → Database → Username-Password-Authentication**
2. Scroll to the bottom of the settings
3. Find the **"Domain"** toggle
4. **Enable** it
5. Save

**Security Note:** Domain-level connections are available to all eligible
third-party applications in the tenant. Audit them carefully: Auth0 CIMD may
require eligible domain-level connections, but ChatGPT and Claude/PAT still use
separate application/authentication paths.

---

## Default Audience

**Purpose:** Ensure tokens include the API audience by default

**Setup Steps:**
1. Go to Settings (gear icon) → General
2. Scroll to "API Authorization Settings"
3. **Default Audience:** `https://letter-irl/api`
4. Save

---

## Social Connections

Configure these identity providers in Authentication → Social:

### Google
1. **In Google Cloud Console:**
   - Create or select a project (e.g., "Letter IRL Production")
   - Go to APIs & Services → Credentials
   - Create Credentials → OAuth client ID
   - If prompted, configure OAuth consent screen first (External, app name, emails)
   - Application type: **Web application**
   - Name: `Auth0 Production`
   - Authorized redirect URI: `https://dev-njmdyqf8n25rqgy7.us.auth0.com/login/callback`
   - Copy Client ID and Client Secret

2. **In Auth0:**
   - Go to Authentication → Social → Google
   - Paste Client ID and Client Secret
   - Go to **Applications** tab within the Google connection
   - Enable toggle for **Letter IRL Website**
   - Save

### Microsoft (Optional - Add Later)
- Create app at [Azure Portal](https://portal.azure.com/)
- Follow similar pattern to Google setup

### Apple (Optional - Add Later)
- Create credentials at [Apple Developer](https://developer.apple.com/)

### GitHub (Optional - Add Later)
- Create OAuth app at [GitHub Developer Settings](https://github.com/settings/developers)

---

## Username-Password Connection

1. Go to **Authentication → Database** in the sidebar
2. Click on **Username-Password-Authentication** (exists by default)
3. Go to the **Applications** tab
4. Enable toggle for **Letter IRL Website**
5. Save

---

## Branding (Optional)

Customize the login page appearance:

1. Go to **Branding → Universal Login** in the sidebar
2. **Logo URL:** `https://letterirl.com/logo.jpg` (after deployment)
3. Set **Primary Color** to match your brand
4. Preview and save

---

## Environment Tag

Change from Development to Production for higher rate limits:

1. Go to **Settings** (gear icon) → **General**
2. Scroll to **Assign Environment Tag**
3. Select **Production**
4. Save

---

## Environment Variables Summary

### MCP Server (letter-irl)

```env
LETTER_IRL_OAUTH_ISSUER=https://dev-njmdyqf8n25rqgy7.us.auth0.com/
LETTER_IRL_OAUTH_AUTH_ENDPOINT=https://dev-njmdyqf8n25rqgy7.us.auth0.com/authorize
LETTER_IRL_OAUTH_TOKEN_ENDPOINT=https://dev-njmdyqf8n25rqgy7.us.auth0.com/oauth/token
LETTER_IRL_OAUTH_JWKS_URI=https://dev-njmdyqf8n25rqgy7.us.auth0.com/.well-known/jwks.json
LETTER_IRL_MCP_RESOURCE=https://api.letterirl.com/mcp
LETTER_IRL_OAUTH_AUDIENCE=https://api.letterirl.com/mcp
LETTER_IRL_OAUTH_ALLOWED_ALGORITHMS=RS256
LETTER_IRL_OAUTH_AUDIENCE=https://letter-irl/api
LETTER_IRL_OAUTH_SCOPES=openid,email,profile
```

### Website (letter-irl-website)

```env
AUTH0_SECRET=<generate with `openssl rand -hex 32`>
AUTH0_BASE_URL=https://letterirl.com
AUTH0_ISSUER_BASE_URL=https://dev-njmdyqf8n25rqgy7.us.auth0.com
AUTH0_CLIENT_ID=wX17u1wOn3XJRVba1ejIappBNpDno3ER
AUTH0_CLIENT_SECRET=<from application settings>
AUTH0_AUDIENCE=https://letter-irl/api
```

---

## Checklist

### Production Tenant (dev-njmdyqf8n25rqgy7)
- [x] Account created (dnicholl@letterirl.com)
- [x] Environment tag set to Production
- [x] Website application created (Regular Web App)
- [x] Website/REST API created (`https://letter-irl/api`)
- [ ] Production CIMD/API changes await DEV acceptance and owner approval
- [x] Legacy DCR state recorded for rollback
- [x] Domain-level connection inventory recorded
- [x] Default audience set
- [x] Google connection configured
- [ ] Microsoft connection configured
- [ ] Apple connection configured
- [ ] GitHub connection configured
- [x] Username-Password enabled
- [x] Branding configured (logo, colors)
- [ ] M2M app created (for sync script)
- [x] Environment variables configured in Railway

### Development Tenant (dev-ky21dxn3qmi71hjl)
- [x] Account exists (dnicholl@objective.works)
- [x] Website application configured
- [x] Website/REST API configured
- [ ] Dedicated DEV `/mcp` API and public CIMD import are owner-gated
- [x] Legacy DCR state recorded for rollback
- [x] Domain-level connection inventory recorded
- [x] Social connections configured
- [x] Username-Password enabled
