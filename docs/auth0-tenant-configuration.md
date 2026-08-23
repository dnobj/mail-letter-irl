# Auth0 Tenant Configuration

**Last Updated:** July 23, 2026

This document provides a complete reference of the Auth0 tenant configuration used for the ChatGPT MCP Server with OAuth authentication.

## Current configuration contract

Development and production each use a dedicated Auth0 MCP API whose identifier
is the exact canonical environment `/mcp` URL. ChatGPT is a manually imported,
strict third-party public CIMD application using authorization code + PKCE S256
and no token endpoint authentication. Grant only `mail:read`, `mail:draft`, and
`mail:send`. Keep website/REST applications and Claude/PAT paths separate.

The DCR/static-client sections below document the temporary rollback baseline,
not the desired configuration. Do not enable them in a normal CIMD rollout.
`private_key_jwt`/Auth0 Enterprise is not part of this design.

## Tenants Overview

| Environment | Tenant Domain | Account |
|-------------|---------------|---------|
| **Development** | `dev-ky21dxn3qmi71hjl.us.auth0.com` | dnicholl@objective.works |
| **Production** | `dev-njmdyqf8n25rqgy7.us.auth0.com` | dnicholl@letterirl.com |

---

## Table of Contents

- [Quick Reference: Application Configuration Matrix](#quick-reference-application-configuration-matrix)
- [Overview](#overview)
- [Tenant Information](#tenant-information)
- [Connections (Identity Providers)](#connections-identity-providers)
- [Applications](#applications)
- [APIs / Resource Servers](#apis--resource-servers)
- [Key Settings for ChatGPT MCP](#key-settings-for-chatgpt-mcp)
- [Management via CLI](#management-via-cli)
- [Common Operations](#common-operations)
- [Environment Configuration](#environment-configuration)

---

## Quick Reference: Application Configuration Matrix

Use this table to verify each application has the correct settings:

| Application | Type | Callbacks Required | Web Origins Required | Domain Connection |
|-------------|------|-------------------|---------------------|-------------------|
| **Mail Letter IRL** | SPA | `https://chat.openai.com/aip/auth/callback`<br>`https://chatgpt.com/connector_platform_oauth_redirect`<br>`https://platform.openai.com/apps-manage/oauth` | `https://chat.openai.com`<br>`https://chatgpt.com`<br>`https://platform.openai.com` | N/A |
| **Letter IRL API** | M2M | None | None | N/A |
| **ChatGPT public CIMD** | Strict third-party public client | Exact current `https://chatgpt.com/connector/oauth/{callback_id}` from CIMD | N/A | Audited eligible connections |

### Tenant-Level Settings Checklist

| Setting | Location | Required Value |
|---------|----------|----------------|
| CIMD registration | Settings → Advanced | Enabled for the target environment |
| MCP API identifier | Applications → APIs | Exact canonical environment `/mcp` URL |
| DCR Enabled | Settings → Advanced | Rollback inventory only |
| Friendly Name | Settings → General | `Letter IRL` |
| Google Connection | Connections | `is_domain_connection: true` |
| Microsoft Connection | Connections | `is_domain_connection: true` |
| Apple Connection | Connections | `is_domain_connection: true` |
| GitHub Connection | Connections | `is_domain_connection: true` |
| Username-Password | Connections | `is_domain_connection: true` |

### Branding Checklist

| Setting | Value | Status (Dev) | Status (Prod) |
|---------|-------|--------------|---------------|
| Friendly Name | `Letter IRL` | ✅ Applied | ⏳ Pending |
| Logo URL | `https://letterirl.com/logo.jpg` | ✅ Applied | ⏳ Pending |
| Favicon URL | `https://letterirl.com/favicon.ico` | ✅ Applied | ⏳ Pending |
| Primary Color | `#1a8ccc` | ✅ Applied | ⏳ Pending |
| Page Background | `#ffffff` | ✅ Applied | ⏳ Pending |
| ChatGPT MCP App Name | `Letter IRL` | ✅ Applied | ⏳ Pending |
| ChatGPT MCP App Logo | `https://letterirl.com/logo.jpg` | ✅ Applied | ⏳ Pending |

---

## Overview

This Auth0 tenant is configured to support:
- **ChatGPT MCP Server** with OAuth 2.1 + PKCE authentication
- **Manual public CIMD registration** for ChatGPT apps
- **5 Authentication Methods**: Google, Microsoft, Apple, GitHub, Email/Password
- **Audited eligible connections** for strict third-party CIMD clients

---

## Tenant Information

| Property | Value |
|----------|-------|
| **Domain** | `dev-ky21dxn3qmi71hjl.us.auth0.com` |
| **Region** | US (dev) |
| **Default Audience** | `https://letter-irl/api` |
| **OIDC DCR Enabled** | Rollback inventory only; not required by ChatGPT CIMD |

### Important Endpoints

```bash
# OAuth Authorization Server Discovery
https://dev-ky21dxn3qmi71hjl.us.auth0.com/.well-known/oauth-authorization-server

# JWKS (JSON Web Key Set)
https://dev-ky21dxn3qmi71hjl.us.auth0.com/.well-known/jwks.json

# Authorization Endpoint
https://dev-ky21dxn3qmi71hjl.us.auth0.com/authorize

# Token Endpoint
https://dev-ky21dxn3qmi71hjl.us.auth0.com/oauth/token

# Dynamic Client Registration (RFC 7591)
https://dev-ky21dxn3qmi71hjl.us.auth0.com/oidc/register
```

---

## Connections (Identity Providers)

All connections are configured as **domain-level connections** (`is_domain_connection: true`) to support ChatGPT's dynamically registered OAuth clients.

### 1. Google (google-oauth2)

```json
{
  "id": "con_0TaXOw40EOEjAtWF",
  "name": "google-oauth2",
  "strategy": "google-oauth2",
  "is_domain_connection": true,
  "options": {
    "email": true,
    "profile": true,
    "scope": ["email", "profile"]
  }
}
```

**Provider Type:** Social (OAuth 2.0)
**Scopes:** `email`, `profile`

### 2. Microsoft (windowslive)

```json
{
  "id": "con_yXECqXNAc3kuLPYs",
  "name": "Microsoft",
  "strategy": "windowslive",
  "is_domain_connection": true,
  "options": {
    "signin": true,
    "scope": ["wl.signin"]
  }
}
```

**Provider Type:** Social (Microsoft Personal Accounts)
**Scopes:** `wl.signin`

> **Note:** This connection supports Microsoft **personal accounts** only. For work/organizational accounts, use an Enterprise connection with Azure AD.

### 3. Apple

```json
{
  "id": "con_FxgZyyw39YHjWKiM",
  "name": "Apple",
  "strategy": "apple",
  "is_domain_connection": true,
  "options": {}
}
```

**Provider Type:** Social (Sign in with Apple)

### 4. GitHub

```json
{
  "id": "con_GDXmYmXKIYPTt0TD",
  "name": "GitHub",
  "strategy": "github",
  "is_domain_connection": true,
  "options": {
    "scope": []
  }
}
```

**Provider Type:** Social (OAuth 2.0)

### 5. Username-Password-Authentication

```json
{
  "id": "con_KsLx9jreL6UbX7ZB",
  "name": "Username-Password-Authentication",
  "strategy": "auth0",
  "is_domain_connection": true,
  "options": {
    "passwordPolicy": "good",
    "brute_force_protection": true,
    "mfa": {
      "active": true,
      "return_enroll_settings": true
    },
    "authentication_methods": {
      "password": {
        "enabled": true
      },
      "passkey": {
        "enabled": false
      }
    },
    "passkey_options": {
      "challenge_ui": "both",
      "local_enrollment_enabled": true,
      "progressive_enrollment_enabled": true
    },
    "strategy_version": 2
  }
}
```

**Provider Type:** Database (Auth0 Database)
**Password Policy:** Good
**Brute Force Protection:** ✅ Enabled
**MFA:** ✅ Available
**Passkeys:** ❌ Currently disabled

---

## Applications

### 1. Default App

| Property | Value |
|----------|-------|
| **Client ID** | `dh1gQFsJJJBqMUhCQ8hlA1XoFSGhQ6or` |
| **Type** | Generic |
| **Grant Types** | `authorization_code`, `implicit`, `refresh_token`, `client_credentials` |

Default application created by Auth0.

### 2. Mail Letter IRL

| Property | Value |
|----------|-------|
| **Client ID** | `fH2bdMWvE7ql8AElZSqXk1c2p3lXjOhx` |
| **Type** | Single Page Application (SPA) |
| **Grant Types** | `authorization_code`, `implicit`, `refresh_token` |
| **Callbacks** | `https://chat.openai.com/aip/auth/callback`<br>`https://chatgpt.com/connector_platform_oauth_redirect`<br>`https://platform.openai.com/apps-manage/oauth` |
| **Logout URLs** | `https://chat.openai.com/aip/auth/callback`<br>`https://chatgpt.com/connector_platform_oauth_redirect` |
| **Web Origins** | `https://chat.openai.com`<br>`https://chatgpt.com`<br>`https://platform.openai.com` |

Main application for the Letter IRL project.

> **Important:** The `https://platform.openai.com/apps-manage/oauth` callback is required for the OpenAI app review process. See [OpenAI Apps SDK Auth Documentation](https://developers.openai.com/apps-sdk/build/auth/).

### 3. Letter IRL API (Test Application)

| Property | Value |
|----------|-------|
| **Client ID** | `PAKBkBq83uRlSJxiyWGYhN9FalzxOBFJ` |
| **Type** | Machine to Machine |
| **Grant Types** | `client_credentials` |

M2M application for testing API access.

### 4. API Explorer Application

| Property | Value |
|----------|-------|
| **Client ID** | `r3lHNjD1zAFNLRgIh0ljtEtuDyerCxO8` |
| **Type** | Machine to Machine |
| **Grant Types** | `client_credentials` |

Auth0's API Explorer for Management API access.

### 5. ChatGPT (Dynamically Registered)

| Property | Value |
|----------|-------|
| **Client ID** | `SGDLjJ3LJC525aAr9ZUebnJhFGkDZcAI` (example) |
| **Type** | Generic |
| **Grant Types** | `authorization_code`, `refresh_token` |
| **Callbacks** | `https://chatgpt.com/connector_platform_oauth_redirect` |

Dynamically registered via RFC 7591 when ChatGPT connects to the MCP server. Multiple instances may exist as users connect/reconnect.

---

## APIs / Resource Servers

### 1. Auth0 Management API

| Property | Value |
|----------|-------|
| **Identifier** | `https://dev-ky21dxn3qmi71hjl.us.auth0.com/api/v2/` |
| **Name** | Auth0 Management API |

Auth0's Management API with 200+ scopes for programmatic tenant administration.

### 2. Legacy website/REST Letter IRL API

| Property | Value |
|----------|-------|
| **Identifier** | `https://letter-irl/api` |
| **Name** | Letter IRL API |
| **Scopes** | None configured |

This identifier remains for website/REST compatibility. Do not repurpose it for
ChatGPT. The dedicated MCP API identifier exactly equals the environment's
canonical `/mcp` resource.

---

## Key Settings for ChatGPT MCP

### Required Auth0 CIMD Configuration

1. **Client ID Metadata Document registration**
   - Import the current OpenAI-hosted HTTPS CIMD URL manually.
   - Verify public client, authorization code, PKCE S256, and no token endpoint
     authentication.

2. **Dedicated MCP resource/API**
   - Identifier: exact canonical environment `/mcp` URL.
   - Permissions: `mail:read`, `mail:draft`, and `mail:send`.
   - Enable the resource-parameter compatibility profile when Auth0 requires it.
   - **Allow Offline Access: enabled.** Without it Auth0 issues no refresh token
     however the client asks, and the connection dies at access-token expiry with
     a human re-consent as the only recovery (issue #160).

2a. **Refresh token settings on the CIMD client** (owner decision, 2026-08-23)

   | Setting | Value | Why |
   |---|---|---|
   | Rotation | **Enabled** | Each use replaces the token; reuse of a retired one signals theft |
   | Absolute lifetime | **30 days** (2592000s) | An abandoned grant dies within a month |
   | Inactivity lifetime | **14 days** (1209600s) | A dormant connection lapses sooner than an active one |

   These bound a real exposure: a refresh token carrying `mail:send` is a standing
   ability to spend a customer's credits and post physical mail whenever their
   ChatGPT account asks. Revocation must still take effect immediately - that is
   CIMD-02b in docs/manual-tests.md, and it is the check that keeps this honest.

   The same settings must be applied to the **production** tenant at cutover
   (#158). They are not inherited from DEV.

3. **Domain-Level Connections**
   - **All 5 connections** must have `is_domain_connection: true`
   - **Why:** Third-party clients (like dynamically registered ChatGPT apps) can only use domain-level connections

4. **OpenAI Review Redirect URI** ⚠️
   - **Location:** Applications → Mail Letter IRL → Settings → Allowed Callback URLs
   - **Required URI:** `https://platform.openai.com/apps-manage/oauth`
   - **Why:** OpenAI's app review process uses this redirect URI to test OAuth flows
   - **Reference:** [OpenAI Apps SDK Auth Docs](https://developers.openai.com/apps-sdk/build/auth/)

### Environment Variables (.env)

The MCP server requires these Auth0 configuration values:

```bash
# Auth0 Endpoints
AUTH0_ISSUER=https://dev-ky21dxn3qmi71hjl.us.auth0.com/
AUTH0_AUTHORIZATION_ENDPOINT=https://dev-ky21dxn3qmi71hjl.us.auth0.com/authorize
AUTH0_TOKEN_ENDPOINT=https://dev-ky21dxn3qmi71hjl.us.auth0.com/oauth/token
AUTH0_JWKS_URI=https://dev-ky21dxn3qmi71hjl.us.auth0.com/.well-known/jwks.json
AUTH0_REGISTRATION_ENDPOINT=https://dev-ky21dxn3qmi71hjl.us.auth0.com/oidc/register

# Auth0 API Configuration
AUTH0_AUDIENCE=https://letter-irl/api
AUTH0_SCOPES=openid,email,profile
```

---

## Management via CLI

### Prerequisites

```bash
# Install Auth0 CLI
npm install -g auth0-cli

# Login
auth0 login
```

### Common CLI Commands

```bash
# List all connections
auth0 api get connections

# List all applications
auth0 apps list

# Search users
auth0 users search

# Get tenant settings
auth0 api get tenant/settings

# List APIs
auth0 api get resource-servers
```

---

## Common Operations

### Enable a Connection as Domain-Level

```bash
# Replace CONNECTION_ID with actual connection ID (e.g., con_0TaXOw40EOEjAtWF)
auth0 api patch connections/CONNECTION_ID --data '{"is_domain_connection": true}'
```

**Example - Enable Google:**
```bash
auth0 api patch connections/con_0TaXOw40EOEjAtWF --data '{"is_domain_connection": true}'
```

### Delete a Dynamically Registered ChatGPT Client

```bash
# Get client ID from apps list
auth0 apps list

# Delete by client ID
auth0 apps delete CLIENT_ID --force
```

### Delete All ChatGPT Clients

```bash
# Get all ChatGPT client IDs
auth0 apps list --json | jq -r '.[] | select(.name == "ChatGPT") | .client_id'

# Delete them (example)
for client_id in $(auth0 apps list --json | jq -r '.[] | select(.name == "ChatGPT") | .client_id'); do
  auth0 apps delete "$client_id" --force
done
```

### Create a Test User

```bash
auth0 users create \
  --connection "Username-Password-Authentication" \
  --email "test@example.com" \
  --password "SecurePassword123!"
```

### Delete a User

```bash
# Search for user
auth0 users search

# Delete by user ID (quote to handle pipe character)
auth0 users delete "auth0|USER_ID" --force
```

### View Connection Details

```bash
# Get full configuration for a specific connection
auth0 api get connections/con_0TaXOw40EOEjAtWF | jq '.'
```

### Check Auth0 Logs (Recent Activity)

```bash
auth0 api get logs | jq '.[] | {type, description, date, client_name, user_name}'
```

---

## Troubleshooting

### Issue: "no connections enabled for the client"

**Solution:** Ensure the connection has `is_domain_connection: true`:

```bash
auth0 api get connections/CONNECTION_ID | jq '{name, is_domain_connection}'
```

### Issue: "dynamic client registration is disabled"

**Solution:** Enable DCR in Auth0 Dashboard:
1. Settings → Advanced
2. Enable "OIDC Dynamic Application Registration"

### Issue: ChatGPT shows "Something went wrong with setting up the connection"

**Check:**
1. Auth0 logs: Auth0 Dashboard → Monitoring → Logs
2. MCP server logs: Check terminal output or `/debug/logs` endpoint
3. Verify all 5 connections are domain-level

### Issue: Social login not appearing in Auth0 Universal Login

**Check:**
1. Connection is enabled: `auth0 api get connections/CONNECTION_ID`
2. Connection has `is_domain_connection: true`
3. Developer credentials are configured for the social provider (in Auth0 Dashboard)

---

## Security Best Practices

1. **Rotate Management API Tokens Regularly**
   - Management API tokens have extensive permissions
   - Use short-lived tokens when possible
   - Store securely (never commit to git)

2. **Enable MFA for Username-Password Auth**
   - Already configured in `Username-Password-Authentication` connection
   - Users can enroll via Auth0 Universal Login

3. **Monitor Auth0 Logs**
   - Check for failed login attempts
   - Monitor for suspicious token exchanges
   - Review dynamically registered clients periodically

4. **Use Environment Variables**
   - Never hardcode Auth0 credentials
   - Use `.env` files (add to `.gitignore`)
   - Validate all required env vars on startup

---

## Environment Configuration

### Current State: Dual Tenants

Letter IRL uses separate Auth0 tenants for complete environment isolation:

| Environment | Auth0 Tenant | Account | Purpose |
|-------------|--------------|---------|---------|
| **Production** | `dev-njmdyqf8n25rqgy7.us.auth0.com` | dnicholl@letterirl.com | Live users, real payments |
| **Development** | `dev-ky21dxn3qmi71hjl.us.auth0.com` | dnicholl@objective.works | Testing, sync from production |

### Configuration Parity Checklist

When updating development, ensure production is also updated:

1. **Connections** - All 5 identity providers with `is_domain_connection: true`
2. **DCR** - Dynamic Client Registration enabled
3. **Default Audience** - Set to `https://letter-irl/api`
4. **Applications** - Create equivalent apps with appropriate callbacks
5. **APIs** - Register `https://letter-irl/api` resource server
6. **Branding** - Logo, colors, friendly name (see Branding Checklist above)

### Environment Variables by Tenant

```bash
# Production (.env)
LETTER_IRL_OAUTH_ISSUER=https://dev-njmdyqf8n25rqgy7.us.auth0.com/
LETTER_IRL_OAUTH_JWKS_URI=https://dev-njmdyqf8n25rqgy7.us.auth0.com/.well-known/jwks.json
LETTER_IRL_OAUTH_AUDIENCE=https://letter-irl/api

# Development (.env.dev)
LETTER_IRL_OAUTH_ISSUER=https://dev-ky21dxn3qmi71hjl.us.auth0.com/
LETTER_IRL_OAUTH_JWKS_URI=https://dev-ky21dxn3qmi71hjl.us.auth0.com/.well-known/jwks.json
LETTER_IRL_OAUTH_AUDIENCE=https://letter-irl/api
```

### Applying Branding to Production

When ready to apply branding to production, switch to the production tenant and run these commands:

```bash
# Switch to production tenant
auth0 tenants use dev-njmdyqf8n25rqgy7.us.auth0.com

# Set tenant friendly name
auth0 api patch "tenants/settings" --data '{"friendly_name": "Letter IRL"}'

# Set branding (logo, favicon, colors)
auth0 api patch "branding" --data '{
  "logo_url": "https://letterirl.com/logo.jpg",
  "favicon_url": "https://letterirl.com/favicon.ico",
  "colors": {
    "primary": "#1a8ccc",
    "page_background": "#ffffff"
  }
}'

# Update the ChatGPT MCP app with name and logo
# NOTE: First find the ChatGPT MCP client ID in production tenant:
auth0 apps list
# Then patch it (replace CLIENT_ID with actual ID):
auth0 api patch "clients/CLIENT_ID" --data '{
  "name": "Letter IRL",
  "logo_uri": "https://letterirl.com/logo.jpg"
}'

# Switch back to development tenant
auth0 tenants use dev-ky21dxn3qmi71hjl.us.auth0.com
```

---

## References

- [Auth0 Documentation](https://auth0.com/docs)
- [Auth0 CLI Reference](https://auth0.github.io/auth0-cli/)
- [RFC 7591: Dynamic Client Registration](https://datatracker.ietf.org/doc/html/rfc7591)
- [OAuth 2.1 Specification](https://oauth.net/2.1/)
- [ChatGPT Apps SDK - MCP Server](https://developers.openai.com/apps-sdk/build/mcp-server/)
- [Letter IRL OAuth Learnings](./learnings/chatgpt-auth0-oauth-learnings.md)

---

## Changelog

### December 29, 2025
- Added Tenants Overview section at top (both dev and prod tenants)
- Added Branding Checklist section with dev/prod status tracking
- Added "Applying Branding to Production" section with CLI commands
- Updated Environment Configuration to reflect dual-tenant reality
- Applied branding to development tenant:
  - Friendly name: "Letter IRL"
  - Logo: https://letterirl.com/logo.jpg
  - Favicon: https://letterirl.com/favicon.ico
  - Primary color: #1a8ccc
  - ChatGPT MCP app renamed to "Letter IRL" with logo

### December 23, 2025
- Added Quick Reference: Application Configuration Matrix
- Added Tenant-Level Settings Checklist
- Added Environment Configuration section for dev/prod parity
- Added OpenAI app review callback (`platform.openai.com/apps-manage/oauth`)
- Updated references to new learnings folder structure

### November 14, 2025
- Initial documentation created
- Enabled domain-level connections for Google, Microsoft, Apple, GitHub
- Cleaned up 16 old dynamically registered ChatGPT clients
- Cleared test users for fresh authentication testing
- Verified all 5 authentication methods working with ChatGPT MCP server
