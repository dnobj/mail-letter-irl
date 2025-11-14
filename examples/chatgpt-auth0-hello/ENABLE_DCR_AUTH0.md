# Enable Dynamic Client Registration (DCR) in Auth0

## The Error You're Seeing

```
Error creating connector
{"statusCode":400,"error":"Bad Request","message":"dynamic client registration is disabled"}
```

## Why This Happens

ChatGPT **requires RFC 7591 Dynamic Client Registration (DCR)** - it's mandatory for the MCP specification. Your Auth0 tenant has DCR disabled by default.

## Solution: Enable DCR in Auth0

### Step 1: Go to Tenant Settings

1. Log into [Auth0 Dashboard](https://manage.auth0.com)
2. Click **Settings** in the left sidebar (gear icon near bottom)
3. Click the **Advanced** tab at the top

### Step 2: Enable OIDC Dynamic Application Registration

Scroll down until you find:

**"OIDC Dynamic Application Registration"**

Toggle the switch to **ON** (enabled).

### Step 3: Save Changes

Scroll to the bottom and click **Save Changes**.

## What This Does

Once enabled:
- ChatGPT can dynamically register OAuth clients via the `/oidc/register` endpoint
- Each ChatGPT connection creates a short-lived OAuth application
- No manual application creation needed
- Complies with RFC 7591

## Verification

Test that DCR is working:

```bash
curl -X POST https://dev-ky21dxn3qmi71hjl.us.auth0.com/oidc/register \
  -H "Content-Type: application/json" \
  -d '{
    "client_name": "Test DCR Client",
    "redirect_uris": ["https://example.com/callback"]
  }'
```

**Expected response**: JSON with `client_id`, `client_secret`, etc.

**If DCR is disabled**: Error message about registration being disabled.

## Update Your .env

Remove the static client ID line:

```bash
# Remove or comment out this line:
# AUTH0_CLIENT_ID=YOUR_CLIENT_ID_HERE
```

Make sure the DCR endpoint is configured:

```bash
# This should be UNcommented:
AUTH0_REGISTRATION_ENDPOINT=https://dev-ky21dxn3qmi71hjl.us.auth0.com/oidc/register
```

## Restart Your Server

```bash
# Stop the server (Ctrl+C)
npm run dev
```

## Try ChatGPT Again

Go back to ChatGPT and try adding your connector:
```
https://amitotically-gubernacular-elise.ngrok-free.dev/manifest.json
```

## If DCR Cannot Be Enabled

If you don't see the "OIDC Dynamic Application Registration" option or it can't be enabled:

### Check Your Auth0 Plan

Some Auth0 plans may not support DCR. Check:
1. Auth0 Dashboard → Settings → Subscription
2. View your current plan features

### Contact Auth0 Support

If DCR is not available on your plan:
- Contact Auth0 support to inquire about DCR availability
- Ask if you need to upgrade to access this feature

### Alternative OAuth Providers

If Auth0 doesn't support DCR on your plan, consider these alternatives that support RFC 7591:

- **Keycloak** (open source, self-hosted)
- **Ory Hydra** (open source, cloud or self-hosted)
- **Azure AD** (supports DCR)
- **Okta** (supports DCR on most plans)
- **FusionAuth** (supports DCR)

## Important Notes

- **DCR is mandatory** for ChatGPT Apps SDK - static clients won't work
- **Open registration model**: Auth0's DCR allows anyone to register clients
- **Security consideration**: Enable only if you trust the clients that will register
- **Client cleanup**: Dynamically registered clients accumulate - you may need to clean them up periodically

## Next Steps After Enabling DCR

1. ✅ Enable DCR in Auth0 Settings → Advanced
2. ✅ Verify DCR endpoint responds successfully
3. ✅ Remove AUTH0_CLIENT_ID from .env
4. ✅ Ensure AUTH0_REGISTRATION_ENDPOINT is set
5. ✅ Set **Default Audience** to `https://letter-irl/api` in Auth0 Settings → Advanced
6. ✅ Restart server
7. ✅ Test with ChatGPT

## Troubleshooting

### Error: "Registration endpoint not found"

**Cause**: DCR not enabled or wrong endpoint URL

**Solution**:
- Verify DCR is enabled in Auth0 Settings → Advanced
- Check endpoint URL is correct: `https://YOUR-TENANT.auth0.com/oidc/register`

### Error: "Forbidden" when testing DCR

**Cause**: Open registration might not be fully enabled

**Solution**: Check Auth0 Settings → Advanced for any additional DCR configuration options

### Still getting "dynamic client registration is disabled"

**Cause**: Settings not saved or not applied

**Solution**:
- Make sure you clicked "Save Changes" in Auth0
- Wait a minute for changes to propagate
- Try the curl test command again
- Check Auth0 logs for any errors

## References

- [Auth0 Dynamic Client Registration Docs](https://auth0.com/docs/get-started/applications/dynamic-client-registration)
- [RFC 7591 - OAuth 2.0 Dynamic Client Registration Protocol](https://datatracker.ietf.org/doc/html/rfc7591)
- [OpenAI Apps SDK Authentication](https://developers.openai.com/apps-sdk/build/auth/)
