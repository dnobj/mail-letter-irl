# Setting Up Without Dynamic Client Registration (DCR)

Your Auth0 plan doesn't support Dynamic Client Registration. Here's how to set up a static OAuth application instead.

## Error You're Seeing

```
Error creating connector
{"statusCode":400,"error":"Bad Request","message":"dynamic client registration is disabled"}
```

## Solution: Create a Static Auth0 Application

### Step 1: Create the Application

1. **Go to Auth0 Dashboard** → https://manage.auth0.com
2. Click **Applications** → **Applications** (left sidebar)
3. Click **+ Create Application** (top right)
4. Configure:
   - **Name**: `ChatGPT MCP`
   - **Type**: Select **Single Page Application**
5. Click **Create**

### Step 2: Configure Application Settings

You'll be taken to the application settings page.

#### Callback URLs

Find **Allowed Callback URLs** and add:
```
https://chat.openai.com/aip/auth/callback,https://chatgpt.com/aip/auth/callback
```

#### Web Origins

Find **Allowed Web Origins** and add:
```
https://chat.openai.com,https://chatgpt.com
```

#### CORS

Find **Allowed Origins (CORS)** and add:
```
https://chat.openai.com,https://chatgpt.com
```

#### Grant Types

Scroll down to **Advanced Settings** → **Grant Types** and ensure these are checked:
- ✅ Authorization Code
- ✅ Refresh Token

**Click Save Changes** at the bottom!

###Step 3: Get Your Client ID

At the top of the Settings page, you'll see:

```
Domain: dev-ky21dxn3qmi71hjl.us.auth0.com
Client ID: abc123xyz...   [Copy button]
```

**Copy the Client ID** (it looks like: `Abc123XyZ789...`)

### Step 4: Update Your .env File

Open `/mnt/c/letter-irl/examples/chatgpt-auth0-hello/.env` and update:

```bash
# Change this line from:
AUTH0_CLIENT_ID=YOUR_CLIENT_ID_HERE

# To (paste your actual Client ID):
AUTH0_CLIENT_ID=Abc123XyZ789YourActualClientIdHere
```

**Save the file!**

### Step 5: Restart Your Server

Stop the server (Ctrl+C) and restart:

```bash
npm run dev
```

### Step 6: Try ChatGPT Again

Go back to ChatGPT and try adding the connector again with your manifest URL:
```
https://amitotically-gubernacular-elise.ngrok-free.dev/manifest.json
```

## What Changed?

- ❌ **Before**: Server advertised DCR endpoint, ChatGPT tried to register dynamically → FAILED
- ✅ **After**: Server advertises static `client_id`, ChatGPT uses your pre-configured application → SUCCESS

## Verification

After restarting, check your debug logs at:
```
https://amitotically-gubernacular-elise.ngrok-free.dev/debug/logs
```

You should see the OAuth metadata now includes `client_id`:
```json
{
  "client_id": "Abc123XyZ789...",
  "authorization_endpoint": "https://dev-ky21dxn3qmi71hjl.us.auth0.com/authorize",
  ...
}
```

## Still Having Issues?

### Issue: "Client does not exist"

**Cause**: Wrong Client ID in .env

**Solution**: Double-check you copied the correct Client ID from Auth0 Dashboard

### Issue: "Redirect URI mismatch"

**Cause**: Callback URLs not configured in Auth0

**Solution**: Make sure you added both callback URLs:
- `https://chat.openai.com/aip/auth/callback`
- `https://chatgpt.com/aip/auth/callback`

### Issue: CORS errors

**Cause**: CORS not configured in Auth0 application

**Solution**: Add ChatGPT origins to "Allowed Origins (CORS)" in your Auth0 application settings

## Quick Checklist

Before trying ChatGPT again:

- [ ] Created Single Page Application in Auth0
- [ ] Added callback URLs
- [ ] Added web origins and CORS
- [ ] Saved changes in Auth0
- [ ] Copied Client ID
- [ ] Updated AUTH0_CLIENT_ID in .env
- [ ] Restarted server (npm run dev)
- [ ] Verified OAuth metadata includes client_id

## Next: Configure Default Audience

Even with the static client, you still need to set Default Audience in Auth0:

1. Auth0 Dashboard → **Settings** → **Advanced**
2. Find **Default Audience**
3. Enter: `https://letter-irl/api`
4. Save Changes

This ensures Auth0 issues JWT tokens (not opaque tokens) that your server can validate.
