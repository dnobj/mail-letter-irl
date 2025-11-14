# Auth0 CORS Configuration (CORRECTED)

## ⚠️ IMPORTANT: CORS Location Has Changed

CORS is configured at the **Application level**, NOT the Tenant level.

## For ChatGPT with Dynamic Client Registration

**Here's the key insight**: ChatGPT uses **Dynamic Client Registration (DCR)**, which means it creates its own OAuth applications automatically. You don't need to manually create an application or configure CORS for it!

### Why CORS Might Not Be an Issue

With the OAuth Authorization Code flow that ChatGPT uses:

1. **Authorization step** - Browser redirects to Auth0 (not a CORS request)
2. **User login** - Happens at Auth0's domain (not a CORS request)
3. **Callback** - Auth0 redirects back to ChatGPT (not a CORS request)
4. **Token exchange** - Server-to-server request (no CORS involved)

**You likely don't need to configure CORS at all** for ChatGPT integration!

## If You DO Need to Configure CORS

If you're seeing CORS errors, here's where to configure it:

### Location: Application Settings (Not Tenant Settings!)

1. **Go to Auth0 Dashboard**
2. Navigate to **Applications → Applications** (left sidebar)
3. **Find or create your application**
   - For ChatGPT with DCR, you won't see the dynamically created apps here
   - If you're using a static application (no DCR), click on your app
4. **Scroll down to find these fields:**
   - **Allowed Web Origins**
   - **Allowed Origins (CORS)**
5. **Add your origins:**
   ```
   https://chat.openai.com
   https://chatgpt.com
   ```
6. **Enable Cross-Origin Authentication** (toggle switch)
7. Click **Save Changes**

## Using Auth0 CLI (Alternative Method)

Yes! Auth0 has a CLI tool for configuration:

### Install Auth0 CLI

```bash
# macOS/Linux
brew tap auth0/auth0-cli && brew install auth0

# Or via npm
npm install -g @auth0/auth0-cli

# Or download binary from https://github.com/auth0/auth0-cli
```

### Login to Auth0

```bash
auth0 login
```

### Update Application Settings

```bash
# List your applications first
auth0 apps list

# Update CORS origins for an application
auth0 apps update <app-id> \
  --origins "https://chat.openai.com,https://chatgpt.com"

# Or update interactively
auth0 apps update
# Then select your app and enter the values
```

### View Current Settings

```bash
# Show application details including CORS settings
auth0 apps show <app-id>
```

## What If I'm Using Dynamic Client Registration?

If ChatGPT is using DCR (which it should be), you have two options:

### Option 1: Let It Work Automatically (Recommended)

Dynamic Client Registration in Auth0 typically handles CORS automatically for the created clients. **You shouldn't need to configure anything.**

### Option 2: Create a Default Application for Testing

If you want to test the OAuth flow manually before ChatGPT integration:

```bash
# Create a test application
auth0 apps create \
  --name "ChatGPT Test App" \
  --type spa \
  --origins "https://chat.openai.com,https://chatgpt.com" \
  --callbacks "https://chat.openai.com/aip/auth/callback"
```

## Actually Testing for CORS Issues

To verify if CORS is actually causing problems:

### Test 1: Check Browser Console

When ChatGPT tries to connect, open browser DevTools (F12) and look for:
```
Access to fetch at 'https://dev-ky21dxn3qmi71hjl.us.auth0.com/...'
from origin 'https://chat.openai.com' has been blocked by CORS policy
```

If you DON'T see this error, CORS is not your problem!

### Test 2: Check Your MCP Server Logs

Look at your debug logs at:
```
https://amitotically-gubernacular-elise.ngrok-free.dev/debug/logs
```

If you see successful authentication or token validation errors (not CORS errors), then the OAuth flow is getting through Auth0 fine.

## The REAL Critical Setting: Default Audience

**This is way more important than CORS for Auth0 + ChatGPT:**

### Where to Set Default Audience

1. **Go to Auth0 Dashboard**
2. Click **Settings** in left sidebar (gear icon) ← THIS is in tenant settings
3. Click **General** or **Advanced** tab
4. Find **Default Audience** field
5. Enter: `https://letter-irl/api`
6. Click **Save Changes**

**This IS a tenant-level setting** and is CRITICAL for JWT tokens to work.

## Summary: What You Actually Need to Configure

For ChatGPT Apps SDK with Auth0:

| Setting | Location | Required? | Value |
|---------|----------|-----------|-------|
| **Default Audience** | Settings → Advanced (Tenant) | ✅ YES (CRITICAL) | `https://letter-irl/api` |
| **API Created** | Applications → APIs | ✅ YES | Identifier: `https://letter-irl/api` |
| **CORS** | Applications → [Your App] | ❌ Probably NO | N/A for DCR |
| **DCR Enabled** | Automatic for most plans | ✅ YES | Check `/oidc/register` endpoint |

## Verification Steps

Instead of worrying about CORS, verify these:

```bash
# 1. Test your MCP server OAuth metadata
curl https://amitotically-gubernacular-elise.ngrok-free.dev/.well-known/oauth-authorization-server

# Should return Auth0 endpoints and code_challenge_methods_supported: ["S256"]

# 2. Test Auth0 endpoints directly
curl https://dev-ky21dxn3qmi71hjl.us.auth0.com/.well-known/openid-configuration

# Should return Auth0's OpenID configuration

# 3. Start your server and watch the debug logs
npm run dev

# 4. Try connecting from ChatGPT and watch for actual errors
```

## If You're Still Seeing CORS Errors

This would be unusual with the DCR flow. If you do see CORS errors:

1. **Check which endpoint is failing** - Is it your MCP server or Auth0?
2. **If it's your MCP server** - Check ALLOWED_ORIGINS in your .env
3. **If it's Auth0** - Then you might need to create a static application with CORS configured
4. **Share the exact error** from browser console for more specific help

## Quick Fix If CORS Is Actually the Problem

Create a static Auth0 application:

1. Auth0 Dashboard → Applications → Create Application
2. Name: "ChatGPT MCP Static"
3. Type: Single Page Application
4. Settings:
   - Allowed Callback URLs: `https://chat.openai.com/aip/auth/callback`
   - Allowed Web Origins: `https://chat.openai.com,https://chatgpt.com`
   - Allowed Origins (CORS): `https://chat.openai.com,https://chatgpt.com`
5. Save Changes
6. Copy Client ID
7. Remove `registration_endpoint` from your server's OAuth metadata
8. Add the static `client_id` to your OAuth metadata

But again, **you probably don't need this** if you're using DCR!
