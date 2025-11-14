# Auth0 Setup - Simplified Guide for ChatGPT

## The Only Two Things You MUST Configure

### 1️⃣ Create an API (You Already Did This! ✅)

- ✅ Auth0 Dashboard → Applications → APIs → Create API
- ✅ Name: `Letter IRL API`
- ✅ Identifier: `https://letter-irl/api`

### 2️⃣ Set Default Audience (DO THIS NOW!)

This is **THE MOST CRITICAL** setting for Auth0 + ChatGPT:

1. Auth0 Dashboard → **Settings** (left sidebar, gear icon)
2. Click **Advanced** tab
3. Scroll down to find **Default Audience** field
4. Enter: `https://letter-irl/api`
5. Click **Save Changes** at bottom

**Why it's critical**: Without this, Auth0 issues opaque tokens instead of JWTs, and your server can't validate them.

## What About CORS?

**You probably DON'T need to configure CORS!**

ChatGPT uses Dynamic Client Registration (DCR), which means:
- ChatGPT creates its own OAuth applications automatically
- The OAuth flow uses browser redirects (not CORS requests)
- Token exchange is server-to-server (no CORS needed)

**Only configure CORS if you see actual CORS errors in the browser console.**

## What About Dynamic Client Registration?

The DCR endpoint should be available by default:
```
https://dev-ky21dxn3qmi71hjl.us.auth0.com/oidc/register
```

**Test it:**
```bash
curl -X POST https://dev-ky21dxn3qmi71hjl.us.auth0.com/oidc/register \
  -H "Content-Type: application/json" \
  -d '{
    "client_name": "Test Client",
    "redirect_uris": ["https://example.com/callback"]
  }'
```

If you get a response with a `client_id`, DCR is working! ✅

If you get an error, your Auth0 plan might not support DCR. See the full SETUP.md for alternatives.

## Quick Checklist

Before testing with ChatGPT:

- [x] API created with identifier `https://letter-irl/api`
- [ ] **Default Audience set to `https://letter-irl/api`** ← DO THIS!
- [ ] Test DCR endpoint works
- [ ] .env file configured with your Auth0 tenant
- [ ] ngrok tunnel running
- [ ] MCP server started (`npm run dev`)

## Verification

After setting Default Audience, test your server:

```bash
# Start server
npm run dev

# In another terminal, test endpoints
curl https://amitotically-gubernacular-elise.ngrok-free.dev/healthz
# Should return: ok

curl https://amitotically-gubernacular-elise.ngrok-free.dev/.well-known/oauth-authorization-server
# Should return JSON with Auth0 endpoints
```

## Ready to Test!

Once Default Audience is set:

1. Open debug logs: `https://amitotically-gubernacular-elise.ngrok-free.dev/debug/logs`
2. Go to ChatGPT Settings → Apps & Connectors → Enable Developer Mode
3. Create new app with manifest URL: `https://amitotically-gubernacular-elise.ngrok-free.dev/manifest.json`
4. Watch the debug logs to see the OAuth flow!

## If Something Goes Wrong

Check debug logs for these common errors:

| Error in Logs | Cause | Fix |
|---------------|-------|-----|
| `audience invalid` | Default Audience not set | Set Default Audience in Auth0 Settings → Advanced |
| `invalid signature` | Token is opaque, not JWT | Set Default Audience in Auth0 Settings → Advanced |
| `Missing Authorization header` (first time only) | Normal - ChatGPT checking auth | This is expected, wait for OAuth flow |
| `Unknown session` | Auth failed before session creation | Check earlier logs for auth errors |

## Using Auth0 CLI (Optional)

Install:
```bash
brew tap auth0/auth0-cli && brew install auth0
# or
npm install -g @auth0/auth0-cli
```

View your API:
```bash
auth0 login
auth0 apis list
auth0 apis show <api-id>
```

**Note**: Default Audience is a tenant setting, not an API setting, so you'll need to use the dashboard to set it.

## That's It!

The Auth0 setup is really just:
1. Create API ✅ (you did this)
2. Set Default Audience ← do this now!

Everything else should work automatically with Dynamic Client Registration.
