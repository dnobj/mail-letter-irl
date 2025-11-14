# Auth0 CORS Configuration Guide

## Important: Where to Configure CORS

**CORS is NOT configured at the API level** - it's configured at the **Tenant level** in Auth0.

Even though you created the API `https://letter-irl/api`, CORS settings are global for your entire Auth0 tenant.

## Step-by-Step CORS Setup

### 1. Navigate to Tenant Settings

1. Log into [Auth0 Dashboard](https://manage.auth0.com)
2. Click **Settings** in the left sidebar (near the bottom, with a gear icon)
3. Click the **Advanced** tab at the top

### 2. Find CORS Settings

Scroll down until you find the **CORS** section. You'll see a field labeled:

**Allowed Origins (CORS)**

### 3. Add ChatGPT Origins

In the **Allowed Origins (CORS)** field, add these URLs (one per line):

```
https://chat.openai.com
https://chatgpt.com
```

**Optional**: You can also add your ngrok domain for testing:
```
https://amitotically-gubernacular-elise.ngrok-free.dev
```

The field should look like:
```
https://chat.openai.com
https://chatgpt.com
https://amitotically-gubernacular-elise.ngrok-free.dev
```

### 4. Save Changes

Scroll to the bottom and click **Save Changes**.

## What This Does

When ChatGPT makes requests to Auth0 (for authorization and token exchange), Auth0 will:

1. Check the `Origin` header in the request
2. Compare it against your allowed origins list
3. Include `Access-Control-Allow-Origin` header in the response if matched
4. Allow the OAuth flow to proceed

Without CORS configured, you'll see errors like:
```
Access to fetch at 'https://dev-ky21dxn3qmi71hjl.us.auth0.com/authorize'
from origin 'https://chat.openai.com' has been blocked by CORS policy
```

## Additional CORS Configuration (Optional)

While you're in the Advanced tab, you might also see:

### Allowed Web Origins
These are origins allowed to call the Auth0 Authentication API. You can add the same origins here:
```
https://chat.openai.com
https://chatgpt.com
```

### Allowed Logout URLs
If you want to allow logout redirects, add:
```
https://chat.openai.com
https://chatgpt.com
```

## About the API Settings

When you look at your API settings (Applications → APIs → Letter IRL API), you'll notice:

- **No CORS settings there** - That's normal!
- **Settings tab** - Shows identifier, signing algorithm
- **Permissions** - Define scopes (optional for this use case)
- **Machine to Machine Applications** - Not needed for ChatGPT

The API configuration mainly defines:
1. **Identifier** (`https://letter-irl/api`) - Used as the `audience` claim in tokens
2. **Signing Algorithm** (RS256) - How tokens are signed
3. **Token Lifetime** (default 24 hours)

## Verification

After configuring CORS, test with curl:

```bash
# Test preflight request
curl -X OPTIONS https://dev-ky21dxn3qmi71hjl.us.auth0.com/authorize \
  -H "Origin: https://chat.openai.com" \
  -H "Access-Control-Request-Method: POST" \
  -v

# Look for this header in response:
# Access-Control-Allow-Origin: https://chat.openai.com
```

## Common Mistakes

❌ **Looking for CORS in API settings** - It's not there!
✅ **CORS is in Tenant Settings → Advanced**

❌ **Forgetting to add both chat.openai.com and chatgpt.com**
✅ **Add both domains**

❌ **Adding http:// instead of https://**
✅ **Use https:// for ChatGPT domains**

## Summary Checklist

- [ ] Go to **Settings** (gear icon in left sidebar)
- [ ] Click **Advanced** tab
- [ ] Find **Allowed Origins (CORS)** field
- [ ] Add `https://chat.openai.com`
- [ ] Add `https://chatgpt.com`
- [ ] Optionally add your ngrok domain
- [ ] Click **Save Changes** at bottom

That's it! CORS is now configured for your entire Auth0 tenant.
