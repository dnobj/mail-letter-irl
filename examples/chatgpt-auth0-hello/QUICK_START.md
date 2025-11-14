# Quick Start Guide

Get up and running in 5 minutes!

## 🎯 Prerequisites

- [ ] Node.js 18+ installed
- [ ] Auth0 account (free tier OK)
- [ ] ngrok installed (or similar HTTPS tunnel)

## 🚀 Setup Steps

### 1. Install Dependencies

```bash
cd examples/chatgpt-auth0-hello
npm install
```

### 2. Configure Auth0 (5 minutes)

**a. Create API**
- Auth0 Dashboard → Applications → APIs → Create API
- Name: `Letter IRL API`
- Identifier: `https://letter-irl/api`
- Click Create

**b. Set Default Audience** (CRITICAL!)
- Auth0 Dashboard → Settings → Advanced
- Default Audience: `https://letter-irl/api`
- Save Changes

**c. Configure CORS**
- Auth0 Dashboard → Settings → Advanced → CORS
- Add:
  ```
  https://chat.openai.com
  https://chatgpt.com
  ```

### 3. Start ngrok

```bash
ngrok http 8788
```

Copy your HTTPS URL (e.g., `https://abc123.ngrok-free.dev`)

### 4. Configure Environment

```bash
cp .env.example .env
```

Edit `.env`:
```bash
# Your ngrok URL
PUBLIC_BASE_URL=https://YOUR-NGROK-URL.ngrok-free.dev

# Your Auth0 tenant (e.g., dev-ky21dxn3qmi71hjl.us.auth0.com)
AUTH0_ISSUER=https://YOUR-TENANT.auth0.com/
AUTH0_AUTHORIZATION_ENDPOINT=https://YOUR-TENANT.auth0.com/authorize
AUTH0_TOKEN_ENDPOINT=https://YOUR-TENANT.auth0.com/oauth/token
AUTH0_JWKS_URI=https://YOUR-TENANT.auth0.com/.well-known/jwks.json
AUTH0_REGISTRATION_ENDPOINT=https://YOUR-TENANT.auth0.com/oidc/register

# From step 2a
AUTH0_AUDIENCE=https://letter-irl/api

# Add your ngrok URL
ALLOWED_ORIGINS=https://chat.openai.com,https://chatgpt.com,https://YOUR-NGROK-URL.ngrok-free.dev
ALLOWED_HOSTS=YOUR-NGROK-URL.ngrok-free.dev,localhost,127.0.0.1
```

### 5. Start Server

```bash
npm run dev
```

You should see:
```
🚀 ChatGPT Auth0 Hello World MCP Server
Server:     http://0.0.0.0:8788
Public URL: https://YOUR-NGROK-URL.ngrok-free.dev
...
```

### 6. Open Debug Logs

In your browser:
```
https://YOUR-NGROK-URL.ngrok-free.dev/debug/logs
```

**Keep this open!** It shows all requests from ChatGPT.

### 7. Test Server

```bash
# Health check
curl https://YOUR-NGROK-URL.ngrok-free.dev/healthz
# Should return: ok

# Manifest
curl https://YOUR-NGROK-URL.ngrok-free.dev/manifest.json
# Should return: JSON with tools

# OAuth metadata
curl https://YOUR-NGROK-URL.ngrok-free.dev/.well-known/oauth-authorization-server
# Should return: JSON with Auth0 endpoints
```

### 8. Add to ChatGPT

1. Go to [ChatGPT](https://chat.openai.com)
2. Settings → Apps & Connectors
3. Enable **Developer Mode**
4. **+ Create new app**
5. Enter: `https://YOUR-NGROK-URL.ngrok-free.dev/manifest.json`
6. Click **Add**

ChatGPT will:
- Fetch your manifest
- Request OAuth authentication
- Redirect you to Auth0 to log in
- Connect to your MCP server

### 9. Test Tool

In ChatGPT:
```
Use the hello_world tool to greet me
```

You should see:
```
Hello, friend! Authenticated as auth0|xxxxx (your@email.com).
```

## 🎉 Success!

Check your debug logs to see the full OAuth flow and MCP communication.

## ❌ Not Working?

### Quick Fixes:

**"Token validation failed: audience invalid"**
→ Set Default Audience in Auth0 tenant settings (step 2b)

**"CORS error"**
→ Add ChatGPT origins to ALLOWED_ORIGINS in .env

**"Failed to fetch"**
→ Make sure ngrok tunnel is running and PUBLIC_BASE_URL is correct

**"PKCE not supported"**
→ Check OAuth metadata includes `code_challenge_methods_supported: ["S256"]`

### Full Troubleshooting:

See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for detailed solutions.

## 📚 Next Steps

- Read [SETUP.md](./SETUP.md) for detailed explanations
- Read [AUTH0_SETUP.md](./AUTH0_SETUP.md) for Auth0 configuration details
- Check [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for common issues

## 💡 Tips

- **Keep debug logs open** - Auto-refreshes every 5 seconds
- **Check Auth0 logs** - Dashboard → Monitoring → Logs
- **Use paid ngrok** - Free version shows warning page
- **Test endpoints individually** - Verify each endpoint works before connecting ChatGPT

---

Need help? Check the debug logs first! They show exactly what's happening.
