# Troubleshooting Guide

Quick reference for common issues when integrating ChatGPT Apps SDK with Auth0.

## 🔍 First Steps for Any Issue

1. **Check debug logs**: Open `https://YOUR-DOMAIN/debug/logs` in browser
2. **Check Auth0 logs**: Auth0 Dashboard → Monitoring → Logs
3. **Check server console**: Look for colored error messages
4. **Verify configuration**: Double-check all environment variables

## ❌ Common Errors and Solutions

### Error: "Token validation failed: audience invalid"

**What you see**:
```
[ERROR] [auth] Token validation failed
  error: "audience invalid"
```

**Cause**: Auth0 is not issuing tokens with the correct `aud` claim.

**Solution**:
1. Go to Auth0 Dashboard → Settings → Advanced
2. Set **Default Audience** to match your `AUTH0_AUDIENCE` value
3. Restart your server
4. Try reconnecting from ChatGPT

**Verify**:
- `AUTH0_AUDIENCE` in `.env` = API Identifier in Auth0 = Default Audience in Auth0

---

### Error: "ChatGPT will refuse to proceed because PKCE appears unsupported"

**What you see**:
ChatGPT shows an error about PKCE not being supported.

**Cause**: Your OAuth metadata doesn't include `code_challenge_methods_supported`.

**Solution**:
1. Test your OAuth metadata endpoint:
   ```bash
   curl https://YOUR-DOMAIN/.well-known/oauth-authorization-server
   ```

2. Verify response includes:
   ```json
   {
     "code_challenge_methods_supported": ["S256"]
   }
   ```

3. If missing, check your `server.ts` includes this in `getAuthorizationMetadata()`

---

### Error: "Missing Authorization header"

**What you see**:
```
[WARN] [auth] No Authorization header present
[INFO] [auth] Sending 401 challenge
```

**This is NORMAL** on first connection! ChatGPT will:
1. Try to connect without auth (gets 401)
2. See the WWW-Authenticate challenge
3. Initiate OAuth flow
4. Retry with Bearer token

**Only a problem if**:
- You see this repeatedly after OAuth flow
- ChatGPT never prompts for login

**Solution**:
- Make sure OAuth metadata endpoint is accessible
- Verify `authorizationServer` URL in manifest.json is correct
- Check Auth0 logs for OAuth flow errors

---

### Error: "Unknown session"

**What you see**:
```
[WARN] [sse] Unknown session
  sessionId: "abc123"
  availableSessions: []
```

**Cause**: SSE session was not created or was cleaned up.

**Debug**:
1. Check if SSE stream was established:
   ```
   [INFO] [sse] ✅ SSE session established
   ```

2. If missing, look for errors during session creation

3. Check if session was closed prematurely:
   ```
   [INFO] [sse] SSE session closed
   ```

**Solution**:
- Verify authentication is succeeding before session creation
- Check network connectivity between ChatGPT and your server
- Look for crashes or errors during session setup

---

### Error: "Failed to fetch" or Network errors

**What you see**:
ChatGPT shows "Failed to fetch" or network error.

**Causes**:
1. **Server not accessible via HTTPS**
   - Verify ngrok tunnel is running
   - Test: `curl https://YOUR-DOMAIN/healthz`
   - Should return `ok`

2. **CORS issues**
   - Check ALLOWED_ORIGINS includes ChatGPT domains
   - Check OPTIONS requests return proper CORS headers

3. **ngrok interstitial page**
   - Free ngrok shows a warning page
   - Use paid ngrok or alternative tunnel

**Solution**:
```bash
# Test accessibility
curl -v https://YOUR-DOMAIN/healthz

# Check CORS
curl -H "Origin: https://chat.openai.com" \
     -H "Access-Control-Request-Method: POST" \
     -X OPTIONS \
     https://YOUR-DOMAIN/mcp/sse

# Should return Access-Control-Allow-Origin header
```

---

### Error: "invalid signature" when validating token

**What you see**:
```
[ERROR] [auth] Token validation failed
  error: "invalid signature"
```

**Causes**:
1. **Wrong JWKS URI**
   - Verify AUTH0_JWKS_URI is correct
   - Should be: `https://YOUR-TENANT.auth0.com/.well-known/jwks.json`

2. **Token not issued by Auth0**
   - Token might be from a different issuer
   - Check token `iss` claim matches AUTH0_ISSUER

3. **Opaque token instead of JWT**
   - Auth0 issued an opaque token (random string)
   - Set Default Audience in Auth0 tenant settings

**Verify**:
```bash
# Test JWKS endpoint
curl https://YOUR-TENANT.auth0.com/.well-known/jwks.json

# Should return public keys
```

**Debug token**:
1. Copy the token from logs (look for "Extracted bearer token")
2. Go to [jwt.io](https://jwt.io)
3. Paste token
4. Check if it's a valid JWT
   - If you see decoded JSON: it's a JWT ✅
   - If you see gibberish: it's an opaque token ❌

---

### Error: "Token has expired"

**What you see**:
```
[ERROR] [auth] Token validation failed
  error: "exp claim timestamp check failed"
```

**Cause**: The access token expired.

**This is normal** after 24 hours (default Auth0 token lifetime).

**Solution**:
- ChatGPT should automatically re-authenticate
- If not, disconnect and reconnect the app in ChatGPT settings
- User may need to log in again

---

### Error: Dynamic Client Registration fails

**What you see in Auth0 logs**:
- 400 or 403 errors on `/oidc/register` endpoint
- "Method not allowed" errors

**Cause**: Your Auth0 plan doesn't support DCR.

**Solutions**:

**Option A: Upgrade Auth0 plan**
- Check Auth0 pricing for DCR support

**Option B: Use static client** (requires code changes)
1. Create an Application in Auth0 Dashboard
2. Get the Client ID
3. Modify `server.ts` to use static client ID
4. Remove `registration_endpoint` from OAuth metadata

---

### Error: CORS preflight fails

**What you see in browser console**:
```
Access to fetch at 'https://YOUR-DOMAIN/mcp/sse' from origin 'https://chat.openai.com'
has been blocked by CORS policy
```

**Cause**: CORS headers not set correctly.

**Solution**:
1. Verify ALLOWED_ORIGINS includes:
   ```
   https://chat.openai.com,https://chatgpt.com
   ```

2. Check OPTIONS handler in server.ts returns:
   ```
   Access-Control-Allow-Origin: https://chat.openai.com
   Access-Control-Allow-Methods: GET, POST, OPTIONS
   Access-Control-Allow-Headers: authorization, content-type, mcp-session-id
   ```

3. Also configure CORS in Auth0 Dashboard

---

### Error: "Client must accept text/event-stream"

**What you see**:
```
[WARN] [sse] Client does not accept text/event-stream
```

**Cause**: Request is missing proper Accept header for SSE.

**This usually means**:
- ChatGPT is not requesting the SSE endpoint correctly
- Your manifest.json has wrong transport configuration

**Solution**:
Check manifest.json includes:
```json
{
  "transport": {
    "type": "sse",
    "stream": "https://YOUR-DOMAIN/mcp/sse",
    "messages": "https://YOUR-DOMAIN/mcp/sse/messages"
  }
}
```

---

### Error: Server crashes or restarts

**What you see**:
Server exits unexpectedly or restarts.

**Debug**:
1. Check for uncaught exceptions in logs
2. Look for the last log entry before crash
3. Check Node.js version (need 18+)
4. Verify all dependencies installed: `npm install`

**Common causes**:
- Missing environment variables (server validates on startup)
- Port already in use
- Out of memory (check large log files)

**Solution**:
```bash
# Check Node version
node --version  # Should be 18 or higher

# Reinstall dependencies
rm -rf node_modules package-lock.json
npm install

# Run with verbose logging
DEBUG=* npm run dev
```

---

## 🔬 Advanced Debugging

### Enable Detailed MCP Logging

Modify `server.ts` to log MCP protocol messages:

```typescript
// In handleSseMessage function, add:
logger.debug('mcp', 'Raw MCP message', {
  body: JSON.parse(body),
  sessionId
}, requestId);
```

### Capture Raw HTTP Requests

Use a proxy to see exactly what ChatGPT sends:

```bash
# Install mitmproxy
brew install mitmproxy

# Run proxy
mitmproxy -p 8080

# Point ngrok through proxy (advanced)
```

### Check Auth0 Token Format

When authentication works, check what token you're getting:

```typescript
// In auth.ts, after successful validation:
logger.debug('auth', 'Token claims', { payload }, requestId);
```

Look for:
- `aud`: Should match your API identifier
- `iss`: Should match your Auth0 issuer
- `exp`: Expiration timestamp
- `scope`: Should include requested scopes

### Test Token Validation Manually

```bash
# Get a token from debug logs
TOKEN="eyJhbGc..."

# Decode header
echo $TOKEN | cut -d. -f1 | base64 -d | jq

# Decode payload
echo $TOKEN | cut -d. -f2 | base64 -d | jq

# Verify signature with JWKS
# (Use jose CLI or online tool)
```

---

## 📊 Health Check Commands

Run these to verify everything is working:

```bash
# 1. Server is running
curl https://YOUR-DOMAIN/healthz
# Expected: ok

# 2. Manifest is accessible
curl https://YOUR-DOMAIN/manifest.json | jq
# Expected: JSON with tools array

# 3. OAuth metadata is correct
curl https://YOUR-DOMAIN/.well-known/oauth-authorization-server | jq
# Expected: JSON with Auth0 endpoints and PKCE support

# 4. Protected resource metadata
curl https://YOUR-DOMAIN/.well-known/oauth-protected-resource | jq
# Expected: JSON with Auth0 issuer

# 5. Auth0 JWKS is accessible
curl https://YOUR-TENANT.auth0.com/.well-known/jwks.json | jq
# Expected: JSON with keys array

# 6. Auth0 OpenID configuration
curl https://YOUR-TENANT.auth0.com/.well-known/openid-configuration | jq
# Expected: JSON with Auth0 endpoints
```

---

## 🎯 Debugging Workflow

When something doesn't work:

1. **Identify the stage** where it fails:
   - ❶ Server startup → Check environment variables
   - ❷ Manifest fetch → Check HTTPS accessibility
   - ❸ OAuth metadata → Check endpoints return correct JSON
   - ❹ OAuth flow → Check Auth0 configuration
   - ❺ Token validation → Check JWKS and audience
   - ❻ SSE connection → Check authentication succeeded
   - ❼ Tool invocation → Check MCP server logs

2. **Check logs** for that stage:
   - Open `/debug/logs` in browser
   - Filter by category (oauth, auth, sse, mcp)
   - Look for ERROR or WARN level logs

3. **Verify configuration** for that stage:
   - OAuth metadata → Check endpoints match Auth0
   - Token validation → Check audience and issuer
   - SSE → Check CORS and allowed origins

4. **Test manually** if possible:
   - Use curl to test endpoints
   - Decode tokens with jwt.io
   - Check Auth0 logs for errors

5. **Compare with working example**:
   - Reference the example .env
   - Verify each value matches the pattern

---

## 🆘 Still Stuck?

If you've tried everything:

1. **Collect information**:
   - Copy your debug logs (remove sensitive tokens!)
   - Copy your .env.example (remove secrets!)
   - Note the exact error message
   - Note what you've already tried

2. **Check Auth0 status**:
   - [Auth0 Status Page](https://status.auth0.com/)

3. **Review documentation**:
   - [OpenAI Apps SDK Docs](https://developers.openai.com/apps-sdk/)
   - [Auth0 OAuth Guide](https://auth0.com/docs/authenticate/protocols/oauth)

4. **Common misconfigurations**:
   - Auth0 issuer missing trailing `/`
   - Audience mismatch between API and environment
   - Default Audience not set in Auth0 tenant
   - CORS not configured in Auth0
   - Wrong JWKS URI (should end with `jwks.json`)
   - ngrok tunnel not running or expired

---

## ✅ Verification Checklist

Before asking for help, verify:

- [ ] Server starts without errors
- [ ] `/healthz` returns `ok`
- [ ] `/manifest.json` returns valid JSON
- [ ] `/.well-known/oauth-authorization-server` returns Auth0 endpoints
- [ ] Auth0 JWKS endpoint is accessible
- [ ] Default Audience is set in Auth0
- [ ] CORS is configured in Auth0
- [ ] All environment variables are set correctly
- [ ] AUTH0_ISSUER has trailing `/`
- [ ] AUTH0_AUDIENCE matches API identifier
- [ ] ngrok tunnel is running (if using ngrok)
- [ ] Debug logs are accessible at `/debug/logs`
- [ ] Auth0 logs show no errors

If all checks pass but it still doesn't work, share your debug logs!
