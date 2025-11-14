# ChatGPT Apps SDK + Auth0 Setup Guide

This guide will help you set up a working ChatGPT Apps SDK integration with Auth0 OAuth authentication, including comprehensive debugging tools.

## 🎯 Overview

ChatGPT uses **OAuth 2.1 with PKCE** and **Dynamic Client Registration (DCR)** to authenticate with your MCP server. This means:

1. ChatGPT will dynamically register a new OAuth client each time it connects
2. It uses PKCE (Proof Key for Code Exchange) with S256 challenge method
3. It expects to find OAuth metadata at standard OpenID discovery endpoints

## 🔧 Prerequisites

- Auth0 account and tenant (e.g., `dev-ky21dxn3qmi71hjl.us.auth0.com`)
- ngrok or similar HTTPS tunnel (ChatGPT requires HTTPS)
- Node.js 18+ installed

## 📋 Step 1: Configure Auth0

### 1.1 Create an API in Auth0

ChatGPT needs an API audience to request access tokens. This is critical!

1. Go to **Auth0 Dashboard → Applications → APIs**
2. Click **Create API**
3. Fill in:
   - **Name**: `Letter IRL API` (or any name)
   - **Identifier**: `https://letter-irl/api` (this is your AUTH0_AUDIENCE)
   - **Signing Algorithm**: `RS256`
4. Click **Create**

### 1.2 Set Default Audience (CRITICAL!)

**This is the key workaround for Auth0 + ChatGPT integration.**

ChatGPT doesn't send the `audience` parameter in OAuth requests, which causes Auth0 to issue opaque tokens instead of JWTs. The fix:

1. Go to **Auth0 Dashboard → Settings → Advanced → Settings**
2. Scroll to **Default Audience**
3. Enter: `https://letter-irl/api` (same as your API identifier)
4. Click **Save**

Without this, you'll get token validation errors!

### 1.3 Enable Dynamic Client Registration

ChatGPT needs to register OAuth clients dynamically.

1. Go to **Auth0 Dashboard → Applications**
2. Check if Dynamic Client Registration is enabled for your tenant
3. The endpoint should be: `https://YOUR-TENANT.auth0.com/oidc/register`

**Note**: Some Auth0 plans may not support DCR. If you get errors about DCR, you may need to:
- Upgrade your Auth0 plan, OR
- Create a static OAuth application (see Alternative Setup below)

### 1.4 Configure CORS (Important!)

1. Go to **Auth0 Dashboard → Settings → Advanced → Settings**
2. Find **Allowed Origins (CORS)**
3. Add:
   ```
   https://chat.openai.com
   https://chatgpt.com
   ```

## 📋 Step 2: Set Up ngrok

ChatGPT requires HTTPS. Use ngrok to tunnel your local server:

```bash
# Install ngrok if needed
brew install ngrok  # or download from ngrok.com

# Start tunnel on port 8788
ngrok http 8788
```

You'll see output like:
```
Forwarding https://amitotically-gubernacular-elise.ngrok-free.dev -> http://localhost:8788
```

**Copy this HTTPS URL** - you'll need it for configuration.

## 📋 Step 3: Configure Environment Variables

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` and update:
   ```bash
   # Your ngrok URL
   PUBLIC_BASE_URL=https://YOUR-NGROK-DOMAIN.ngrok-free.dev

   # Your Auth0 tenant (replace with your tenant domain)
   AUTH0_ISSUER=https://YOUR-TENANT.auth0.com/
   AUTH0_AUTHORIZATION_ENDPOINT=https://YOUR-TENANT.auth0.com/authorize
   AUTH0_TOKEN_ENDPOINT=https://YOUR-TENANT.auth0.com/oauth/token
   AUTH0_JWKS_URI=https://YOUR-TENANT.auth0.com/.well-known/jwks.json
   AUTH0_REGISTRATION_ENDPOINT=https://YOUR-TENANT.auth0.com/oidc/register

   # Your API identifier from Step 1.1
   AUTH0_AUDIENCE=https://letter-irl/api

   # Add your ngrok domain to allowed origins and hosts
   ALLOWED_ORIGINS=https://chat.openai.com,https://chatgpt.com,https://YOUR-NGROK-DOMAIN.ngrok-free.dev
   ALLOWED_HOSTS=YOUR-NGROK-DOMAIN.ngrok-free.dev,localhost,127.0.0.1
   ```

## 📋 Step 4: Install and Run

```bash
# Install dependencies
npm install

# Run in development mode (with auto-reload)
npm run dev

# Or build and run in production mode
npm run build
npm start
```

You should see:
```
╔═══════════════════════════════════════════════════════════════════════════╗
║  🚀 ChatGPT Auth0 Hello World MCP Server                                 ║
╠═══════════════════════════════════════════════════════════════════════════╣
║  Server:     http://0.0.0.0:8788                                         ║
║  Public URL: https://YOUR-NGROK-DOMAIN.ngrok-free.dev                    ║
...
```

## 📋 Step 5: Test the Server

Before connecting ChatGPT, verify your server is working:

### 5.1 Check Health
```bash
curl https://YOUR-NGROK-DOMAIN.ngrok-free.dev/healthz
# Should return: ok
```

### 5.2 Check Manifest
```bash
curl https://YOUR-NGROK-DOMAIN.ngrok-free.dev/manifest.json
# Should return JSON with server configuration
```

### 5.3 Check OAuth Metadata
```bash
curl https://YOUR-NGROK-DOMAIN.ngrok-free.dev/.well-known/oauth-authorization-server
# Should return OAuth discovery document with Auth0 endpoints
```

**Verify this response includes**:
```json
{
  "code_challenge_methods_supported": ["S256"]
}
```

This is REQUIRED for ChatGPT to work!

## 📋 Step 6: Open Debug Logs

**This is your secret weapon for troubleshooting!**

Open in your browser:
```
https://YOUR-NGROK-DOMAIN.ngrok-free.dev/debug/logs
```

This shows real-time logs of:
- All HTTP requests from ChatGPT
- OAuth flow steps
- SSE connection establishment
- MCP tool invocations
- Authentication attempts
- Errors with full details

**Keep this open while testing!** It will auto-refresh every 5 seconds.

## 📋 Step 7: Add to ChatGPT

1. Go to [ChatGPT](https://chat.openai.com)
2. Click your profile → **Settings**
3. Go to **Apps & Connectors**
4. Enable **Developer Mode**
5. Click **+ Create new app**
6. Enter your manifest URL:
   ```
   https://YOUR-NGROK-DOMAIN.ngrok-free.dev/manifest.json
   ```
7. Click **Add**

## 🔍 Debugging the OAuth Flow

When ChatGPT tries to connect, watch your debug logs. You should see this sequence:

### Expected Flow:

1. **ChatGPT fetches manifest**
   ```
   [INFO] [oauth] Manifest requested
   ```

2. **ChatGPT fetches OAuth metadata**
   ```
   [INFO] [oauth] Authorization server metadata requested
   ```

3. **ChatGPT tries to access SSE stream (unauthenticated)**
   ```
   [WARN] [auth] No Authorization header present
   [INFO] [auth] Sending 401 challenge
   ```

4. **ChatGPT performs Dynamic Client Registration** (you won't see this - it goes to Auth0)

5. **ChatGPT redirects user to Auth0 for login** (browser-based)

6. **User logs in and consents**

7. **Auth0 redirects back to ChatGPT with authorization code**

8. **ChatGPT exchanges code for access token** (at Auth0 token endpoint)

9. **ChatGPT retries SSE stream with Bearer token**
   ```
   [DEBUG] [auth] Starting authentication
   [DEBUG] [auth] Extracted bearer token
   [DEBUG] [auth] Fetching JWKS from Auth0
   [DEBUG] [auth] Verifying JWT signature and claims
   [DEBUG] [auth] JWT verification successful
   [INFO] [auth] ✅ Authentication successful
   [INFO] [sse] ✅ SSE session established
   ```

10. **MCP session active - tools can be called**

### Common Issues and Solutions:

#### ❌ Issue: "Token validation failed: audience invalid"

**Cause**: Auth0 is not issuing tokens with the correct audience claim.

**Solution**:
- Make sure you set the **Default Audience** in Auth0 tenant settings (Step 1.2)
- Verify AUTH0_AUDIENCE in your .env matches the API identifier

#### ❌ Issue: "ChatGPT will refuse to proceed because PKCE appears unsupported"

**Cause**: Your OAuth metadata doesn't include `code_challenge_methods_supported: ["S256"]`

**Solution**:
- Check the `/.well-known/oauth-authorization-server` endpoint
- The server.ts hardcodes this - make sure you're using the latest code

#### ❌ Issue: Dynamic Client Registration fails

**Cause**: Your Auth0 plan might not support DCR, or the endpoint is wrong.

**Solution**:
1. Check if `AUTH0_REGISTRATION_ENDPOINT` is correct
2. Try removing it from `.env` to see the error message
3. If DCR is not available, see "Alternative Setup" below

#### ❌ Issue: "Unknown session" errors in SSE messages

**Cause**: Session was created but not persisted correctly, or sessionId mismatch.

**Solution**:
- Check debug logs for session creation
- Verify the sessionId in the SSE message URL matches an active session
- Look for session cleanup happening too early

#### ❌ Issue: CORS errors

**Cause**: ChatGPT origin not in ALLOWED_ORIGINS.

**Solution**:
- Add `https://chat.openai.com` and `https://chatgpt.com` to ALLOWED_ORIGINS
- Also configure CORS in Auth0 Dashboard

#### ❌ Issue: ngrok "Visit Site" warning page

**Cause**: ngrok shows an interstitial warning page that breaks API calls.

**Solution**:
- Use a paid ngrok account to disable the warning page, OR
- Use an alternative tunnel like Cloudflare Tunnel, OR
- Deploy to a real HTTPS server (Railway, Fly.io, etc.)

## 🔬 Advanced Debugging

### View logs as JSON
```bash
curl https://YOUR-NGROK-DOMAIN.ngrok-free.dev/debug/logs?format=json
```

### Filter logs
```bash
# Only auth-related logs
https://YOUR-NGROK-DOMAIN.ngrok-free.dev/debug/logs?category=auth

# Only errors
https://YOUR-NGROK-DOMAIN.ngrok-free.dev/debug/logs?level=error

# Logs since a specific time
https://YOUR-NGROK-DOMAIN.ngrok-free.dev/debug/logs?since=2025-11-10T12:00:00Z
```

### Clear logs
```bash
curl -X POST https://YOUR-NGROK-DOMAIN.ngrok-free.dev/debug/logs/clear
```

## 🔄 Alternative Setup: Static OAuth Client

If Dynamic Client Registration doesn't work, you can create a static OAuth application:

1. Go to **Auth0 Dashboard → Applications → Create Application**
2. Choose **Single Page Application**
3. Add these settings:
   - **Allowed Callback URLs**: `https://chat.openai.com/aip/auth/callback`
   - **Allowed Web Origins**: `https://chat.openai.com, https://chatgpt.com`
   - **Application Type**: SPA

4. Get the Client ID

5. Modify `server.ts` to skip DCR and use your static client
   (This requires code changes - let me know if you need help with this)

## 📚 Additional Resources

- [OpenAI Apps SDK Documentation](https://developers.openai.com/apps-sdk/)
- [OpenAI Apps SDK Authentication](https://developers.openai.com/apps-sdk/build/auth/)
- [Auth0 OAuth Documentation](https://auth0.com/docs/authenticate/protocols/oauth)
- [Model Context Protocol](https://spec.modelcontextprotocol.io/)

## 🎉 Success!

Once authenticated, try in ChatGPT:
```
Use the hello_world tool to greet me
```

You should see:
```
Hello, friend! Authenticated as auth0|xxxxx (your@email.com).
```

And in your debug logs:
```
[INFO] [mcp] Tool invoked: hello_world
```

## 💡 Tips

- **Keep debug logs open** - they update every 5 seconds and show exactly what ChatGPT is doing
- **Check both server logs and Auth0 logs** - Auth0 Dashboard → Monitoring → Logs shows OAuth flow
- **Test endpoints individually** - verify health, manifest, and OAuth metadata work before connecting ChatGPT
- **Use a consistent ngrok domain** - free ngrok URLs change each restart; paid plans get static domains
- **Watch for token expiration** - tokens expire after 24 hours by default in Auth0

## 🆘 Still Having Issues?

1. Check your debug logs at `/debug/logs`
2. Verify Auth0 configuration (especially Default Audience)
3. Test OAuth metadata endpoint
4. Check Auth0 Dashboard → Monitoring → Logs for OAuth errors
5. Share your debug logs (with sensitive data removed) for help
