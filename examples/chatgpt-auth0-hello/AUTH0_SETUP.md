# Detailed Auth0 Configuration Guide

This guide provides step-by-step instructions with screenshots for configuring Auth0 to work with ChatGPT Apps SDK.

## 🎯 Prerequisites

- An Auth0 account (free tier works for development)
- Admin access to your Auth0 tenant

## 📋 Step-by-Step Configuration

### Step 1: Create an API

This is the most critical step for Auth0 integration with ChatGPT.

1. **Navigate to APIs**
   - Log into Auth0 Dashboard
   - Click **Applications** in left sidebar
   - Click **APIs**
   - Click **+ Create API** button

2. **Configure the API**
   - **Name**: `Letter IRL API` (or any descriptive name)
   - **Identifier**: `https://letter-irl/api`
     - ⚠️ This MUST match your `AUTH0_AUDIENCE` environment variable
     - ⚠️ This should be a URI (doesn't need to be a real URL)
     - Example: `https://letter-irl/api`, `https://myapp.example.com/api`
   - **Signing Algorithm**: `RS256` (default, leave as-is)

3. **Click Create**

4. **Copy the Identifier**
   - You'll need this for:
     - `AUTH0_AUDIENCE` environment variable
     - Auth0 Default Audience (next step)

### Step 2: Set Default Audience (CRITICAL!)

**Why this is needed**: ChatGPT doesn't send the `audience` parameter in OAuth requests. Without this, Auth0 issues opaque tokens instead of JWTs, and your server can't validate them.

1. **Navigate to Tenant Settings**
   - Click **Settings** in left sidebar
   - Click **Advanced** tab
   - Scroll down to find **Settings** section

2. **Set Default Audience**
   - Find the field **Default Audience**
   - Enter: `https://letter-irl/api` (the same identifier from Step 1)
   - Click **Save Changes** at bottom of page

3. **Verify**
   - The Default Audience should now show your API identifier
   - This ensures all tokens issued by Auth0 will have the correct `aud` claim

### Step 3: Enable Dynamic Client Registration

ChatGPT uses Dynamic Client Registration (DCR) to create OAuth clients on-the-fly.

1. **Check if DCR is Available**
   - Navigate to **Applications → Applications**
   - Look for any mention of "Dynamic Client Registration"
   - The endpoint should be: `https://YOUR-TENANT.auth0.com/oidc/register`

2. **Verify Endpoint Access**
   - Test the DCR endpoint:
     ```bash
     curl -X POST https://YOUR-TENANT.auth0.com/oidc/register \
       -H "Content-Type: application/json" \
       -d '{
         "client_name": "Test Client",
         "redirect_uris": ["https://example.com/callback"]
       }'
     ```
   - You should get a response with a `client_id` (if successful)
   - OR an error message (if DCR is not enabled)

3. **If DCR is Not Available**
   - Some Auth0 plans don't support DCR
   - You have two options:
     - **Option A**: Upgrade Auth0 plan
     - **Option B**: Create a static OAuth application (see Alternative Setup below)

### Step 4: Configure CORS

Auth0 needs to allow requests from ChatGPT domains.

1. **Navigate to Settings**
   - Click **Settings** in left sidebar
   - Click **Advanced** tab
   - Find **Allowed Origins (CORS)** section

2. **Add ChatGPT Origins**
   - Add these URLs (one per line):
     ```
     https://chat.openai.com
     https://chatgpt.com
     ```

3. **Click Save Changes**

### Step 5: Get Your Auth0 Configuration Values

You need several values from Auth0 for your `.env` file.

#### Tenant Domain

1. Look at your Auth0 Dashboard URL
2. Your tenant domain is in the URL: `https://manage.auth0.com/dashboard/us/YOUR-TENANT/`
3. Full issuer URL: `https://YOUR-TENANT.auth0.com/` (with trailing slash!)

Example:
- Dashboard URL: `https://manage.auth0.com/dashboard/us/dev-ky21dxn3qmi71hjl/`
- Tenant domain: `dev-ky21dxn3qmi71hjl.us.auth0.com`
- Issuer: `https://dev-ky21dxn3qmi71hjl.us.auth0.com/`

#### OAuth Endpoints

Auth0 uses standard endpoints:

```bash
# Replace YOUR-TENANT with your actual tenant domain

# Issuer (with trailing slash!)
https://YOUR-TENANT.auth0.com/

# Authorization Endpoint
https://YOUR-TENANT.auth0.com/authorize

# Token Endpoint
https://YOUR-TENANT.auth0.com/oauth/token

# JWKS URI
https://YOUR-TENANT.auth0.com/.well-known/jwks.json

# Dynamic Client Registration (if available)
https://YOUR-TENANT.auth0.com/oidc/register
```

Example for `dev-ky21dxn3qmi71hjl.us.auth0.com`:

```bash
AUTH0_ISSUER=https://dev-ky21dxn3qmi71hjl.us.auth0.com/
AUTH0_AUTHORIZATION_ENDPOINT=https://dev-ky21dxn3qmi71hjl.us.auth0.com/authorize
AUTH0_TOKEN_ENDPOINT=https://dev-ky21dxn3qmi71hjl.us.auth0.com/oauth/token
AUTH0_JWKS_URI=https://dev-ky21dxn3qmi71hjl.us.auth0.com/.well-known/jwks.json
AUTH0_REGISTRATION_ENDPOINT=https://dev-ky21dxn3qmi71hjl.us.auth0.com/oidc/register
```

### Step 6: Configure Environment Variables

1. **Copy .env.example to .env**
   ```bash
   cp .env.example .env
   ```

2. **Update .env with your values**
   ```bash
   # Your Auth0 tenant (from Step 5)
   AUTH0_ISSUER=https://YOUR-TENANT.auth0.com/
   AUTH0_AUTHORIZATION_ENDPOINT=https://YOUR-TENANT.auth0.com/authorize
   AUTH0_TOKEN_ENDPOINT=https://YOUR-TENANT.auth0.com/oauth/token
   AUTH0_JWKS_URI=https://YOUR-TENANT.auth0.com/.well-known/jwks.json
   AUTH0_REGISTRATION_ENDPOINT=https://YOUR-TENANT.auth0.com/oidc/register

   # Your API identifier (from Step 1)
   AUTH0_AUDIENCE=https://letter-irl/api

   # Your ngrok URL (from ngrok tunnel)
   PUBLIC_BASE_URL=https://YOUR-NGROK-DOMAIN.ngrok-free.dev
   ALLOWED_ORIGINS=https://chat.openai.com,https://chatgpt.com,https://YOUR-NGROK-DOMAIN.ngrok-free.dev
   ALLOWED_HOSTS=YOUR-NGROK-DOMAIN.ngrok-free.dev,localhost,127.0.0.1
   ```

## 🔍 Verification Steps

### Verify Auth0 Configuration

1. **Test OpenID Configuration**
   ```bash
   curl https://YOUR-TENANT.auth0.com/.well-known/openid-configuration
   ```

   Should return JSON with these fields:
   ```json
   {
     "issuer": "https://YOUR-TENANT.auth0.com/",
     "authorization_endpoint": "https://YOUR-TENANT.auth0.com/authorize",
     "token_endpoint": "https://YOUR-TENANT.auth0.com/oauth/token",
     "jwks_uri": "https://YOUR-TENANT.auth0.com/.well-known/jwks.json",
     ...
   }
   ```

2. **Test JWKS Endpoint**
   ```bash
   curl https://YOUR-TENANT.auth0.com/.well-known/jwks.json
   ```

   Should return JSON with public keys:
   ```json
   {
     "keys": [
       {
         "kty": "RSA",
         "use": "sig",
         "kid": "...",
         ...
       }
     ]
   }
   ```

3. **Verify Default Audience**
   - Create a test OAuth flow and check the issued token
   - Use [jwt.io](https://jwt.io) to decode the token
   - Verify the `aud` claim matches your API identifier

### Verify Your MCP Server

1. **Start your server**
   ```bash
   npm run dev
   ```

2. **Test OAuth Metadata**
   ```bash
   curl https://YOUR-NGROK-DOMAIN.ngrok-free.dev/.well-known/oauth-authorization-server
   ```

   Should return:
   ```json
   {
     "issuer": "https://YOUR-TENANT.auth0.com/",
     "authorization_endpoint": "https://YOUR-TENANT.auth0.com/authorize",
     "token_endpoint": "https://YOUR-TENANT.auth0.com/oauth/token",
     "code_challenge_methods_supported": ["S256"],
     ...
   }
   ```

   ✅ **Critical**: Verify `code_challenge_methods_supported` includes `"S256"`

## ⚠️ Common Configuration Mistakes

### ❌ Mistake 1: Forgetting the Trailing Slash

```bash
# WRONG
AUTH0_ISSUER=https://dev-ky21dxn3qmi71hjl.us.auth0.com

# CORRECT
AUTH0_ISSUER=https://dev-ky21dxn3qmi71hjl.us.auth0.com/
```

The OpenID spec requires the issuer to end with a `/`.

### ❌ Mistake 2: Audience Mismatch

```bash
# In Auth0 API settings
Identifier: https://letter-irl/api

# In .env - MUST MATCH EXACTLY
AUTH0_AUDIENCE=https://letter-irl/api

# In Auth0 Tenant Settings - MUST MATCH EXACTLY
Default Audience: https://letter-irl/api
```

All three must be identical!

### ❌ Mistake 3: Not Setting Default Audience

Without Default Audience in Auth0 tenant settings:
- Auth0 issues **opaque tokens** (random strings)
- Your server can't validate opaque tokens
- You get "invalid signature" errors

With Default Audience:
- Auth0 issues **JWT tokens** (signed JSON)
- Your server can validate using JWKS
- Authentication works!

### ❌ Mistake 4: Wrong JWKS URI

```bash
# WRONG - this is for Authorization Server metadata
https://dev-ky21dxn3qmi71hjl.us.auth0.com/.well-known/openid-configuration

# CORRECT - this is the actual JWKS endpoint
https://dev-ky21dxn3qmi71hjl.us.auth0.com/.well-known/jwks.json
```

### ❌ Mistake 5: CORS Not Configured

If CORS is not set in Auth0:
- ChatGPT can't complete OAuth flow
- You see CORS errors in browser console
- OAuth flow fails silently

Always add `https://chat.openai.com` and `https://chatgpt.com` to CORS.

## 🔄 Alternative Setup: Static OAuth Application

If Dynamic Client Registration is not available on your Auth0 plan:

### Create a Static Application

1. **Create Application**
   - Go to **Applications → Applications**
   - Click **+ Create Application**
   - Name: `ChatGPT MCP`
   - Type: **Single Page Application**
   - Click **Create**

2. **Configure Application**
   - **Allowed Callback URLs**:
     ```
     https://chat.openai.com/aip/auth/callback
     https://chatgpt.com/aip/auth/callback
     ```
   - **Allowed Web Origins**:
     ```
     https://chat.openai.com
     https://chatgpt.com
     ```
   - **Allowed Origins (CORS)**:
     ```
     https://chat.openai.com
     https://chatgpt.com
     ```

3. **Get Client ID**
   - Copy the **Client ID** from the Settings tab
   - **Client Secret** is not needed (public client)

4. **Modify server.ts**
   You'll need to modify the OAuth metadata to include:
   ```typescript
   // In getAuthorizationMetadata()
   return {
     // ... existing fields ...
     client_id: "YOUR-STATIC-CLIENT-ID",  // Add this
     // Remove or comment out registration_endpoint
   };
   ```

**Note**: Static clients are less secure than DCR but work if DCR is unavailable.

## 🧪 Testing the Configuration

### Manual OAuth Flow Test

Test the OAuth flow manually to verify Auth0 configuration:

1. **Get Authorization URL**
   ```bash
   https://YOUR-TENANT.auth0.com/authorize?
     response_type=code&
     client_id=YOUR_CLIENT_ID&
     redirect_uri=http://localhost:3000/callback&
     scope=openid%20email%20profile&
     audience=https://letter-irl/api&
     code_challenge=CHALLENGE&
     code_challenge_method=S256
   ```

2. **Visit URL in Browser**
   - You should see Auth0 login page
   - Log in with a test user
   - You should be redirected to callback URL with `code` parameter

3. **Exchange Code for Token**
   ```bash
   curl -X POST https://YOUR-TENANT.auth0.com/oauth/token \
     -H "Content-Type: application/json" \
     -d '{
       "grant_type": "authorization_code",
       "client_id": "YOUR_CLIENT_ID",
       "code": "AUTHORIZATION_CODE",
       "redirect_uri": "http://localhost:3000/callback",
       "code_verifier": "VERIFIER"
     }'
   ```

4. **Decode the Token**
   - Copy the `access_token` from response
   - Go to [jwt.io](https://jwt.io)
   - Paste the token
   - Verify:
     - `iss` claim matches your issuer
     - `aud` claim matches your audience
     - Token has not expired (`exp` claim)

## 📚 Auth0 Resources

- [Auth0 APIs Documentation](https://auth0.com/docs/get-started/apis)
- [Auth0 OAuth 2.0 Guide](https://auth0.com/docs/authenticate/protocols/oauth)
- [Auth0 JWKS Endpoint](https://auth0.com/docs/secure/tokens/json-web-tokens/json-web-key-sets)
- [Auth0 Dynamic Client Registration](https://auth0.com/docs/get-started/applications/configure-client-credentials)

## ✅ Configuration Checklist

Before testing with ChatGPT, verify:

- [ ] Created API in Auth0 with identifier `https://letter-irl/api`
- [ ] Set Default Audience in Auth0 tenant settings
- [ ] Configured CORS to allow ChatGPT origins
- [ ] Set all AUTH0_* environment variables in `.env`
- [ ] Verified AUTH0_AUDIENCE matches API identifier exactly
- [ ] Verified AUTH0_ISSUER ends with `/`
- [ ] Tested JWKS endpoint returns public keys
- [ ] Tested OAuth metadata endpoint returns `code_challenge_methods_supported: ["S256"]`
- [ ] Started ngrok tunnel and updated PUBLIC_BASE_URL
- [ ] Server starts without errors
- [ ] Debug logs are accessible at /debug/logs

Once all items are checked, you're ready to connect ChatGPT!
