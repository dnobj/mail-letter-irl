# Letter IRL MCP Server - Setup Guide

## ✅ Integration Complete!

The Auth0 OAuth authentication has been successfully integrated with the main Letter IRL MCP server.

> Current ChatGPT target: Auth0 manual CIMD registration for a public client,
> authorization code + PKCE S256, and `token_endpoint_auth_method=none`.
> Auth0 discovery is authoritative. Letter IRL's authorization-server proxy and
> `/oauth/register` exist only behind the temporary rollback flag. Claude and
> other non-ChatGPT clients use a separate OAuth adapter or PAT.

## What's Working

✅ **Auth0 OAuth 2.1 + PKCE** with 5 identity providers
✅ **4 MCP Tools** integrated (quote, send, status, balance)
✅ **Per-user authentication** - Each request authenticated via JWT
✅ **Dual protocol** - Streamable HTTP (preferred) + SSE fallback
✅ **OAuth discovery** endpoints configured
✅ **Manifest** updated with correct endpoints

## Quick Start

### 1. Start the Server

```bash
cd /mnt/c/letter-irl
npm run mcp:http
```

The server will start on `http://0.0.0.0:8788`

### 2. Expose via ngrok (Already Running)

Your ngrok URL is already configured:
```
https://amitotically-gubernacular-elise.ngrok-free.dev
```

If you need to restart ngrok:
```bash
ngrok http 8788
```

### 3. Add to ChatGPT

1. Open ChatGPT Settings → Connectors → Create
2. Enter MCP endpoint:
   ```
   https://amitotically-gubernacular-elise.ngrok-free.dev/mcp
   ```
3. ChatGPT will auto-discover OAuth configuration
4. Complete Auth0 login (choose from 5 providers)
5. Test with: "Check my Letter IRL balance"

## Architecture Changes

### What We Did

1. **Environment Configuration** (`.env`)
   - Added Auth0 OAuth endpoints
   - Configured MCP paths
   - Set CORS origins

2. **HTTP Server** (`src/mcp/httpServer.ts`)
   - Added `import "dotenv/config"` at top
   - Updated to use per-session MCP servers (like chatgpt-auth0-hello)
   - Auth info now properly passed to all tool handlers

3. **Tool Registration** (`src/mcp/registerTools.ts`)
   - Now accepts `authInfo` parameter
   - User ID extracted from JWT and passed to tools
   - Each tool execution uses authenticated user's account

4. **Manifest** (`manifest.json`)
   - Updated URL to `/mcp` (works with both Streamable HTTP and SSE)
   - OAuth discovery points to `.well-known/oauth-authorization-server`

### Key Files Modified

```
/mnt/c/letter-irl/
├── .env                          # ✨ Created - Auth0 + server config
├── manifest.json                 # ✅ Updated - Correct endpoints
├── src/mcp/httpServer.ts         # ✅ Updated - dotenv + per-session servers
└── src/mcp/registerTools.ts      # ✅ Updated - Auth context passing
```

## Testing the Integration

### Test Server Health

```bash
curl http://localhost:8788/healthz
# Expected: ok

curl http://localhost:8788/
# Expected: {"status":"ok","service":"letter-irl"}
```

### Test OAuth Discovery

```bash
curl http://localhost:8788/.well-known/oauth-protected-resource | jq
curl https://YOUR_AUTH0_TENANT/.well-known/openid-configuration | jq
```

The first response must name the exact `/mcp` resource, Auth0 issuer, and three
product scopes. Auth0's response—not a Letter IRL proxy—must describe CIMD and
authorization-server capabilities. The imported ChatGPT application must use:

```json
{
  "grant_types": ["authorization_code"],
  "token_endpoint_auth_method": "none",
  "code_challenge_method": "S256"
}
```

### Test Tools in ChatGPT

1. **Check Balance**:
   ```
   "Check my Letter IRL credit balance"
   ```

2. **Draft a Letter**:
   ```
   "Help me draft a letter to John Doe at 123 Main St, Springfield, IL 62701"
   ```

3. **View Preview**:
   - ChatGPT will call `quote_and_preview_letter`
   - You'll see preview HTML and credit cost

4. **Send Letter** (if you approve):
   - ChatGPT will call `send_letter` with `confirm: true`
   - Credits deducted, order created

5. **Check Status**:
   ```
   "What's the status of my last letter?"
   ```

## Authentication Flow

```
┌─────────┐     1. Connect       ┌──────────┐
│ChatGPT  │ ──────────────────> │Letter IRL│
│         │                      │MCP Server│
└─────────┘                      └──────────┘
     │                                 │
     │      2. OAuth Discovery         │
     │ <─────────────────────────────  │
     │    (Auth0 endpoints)            │
     │                                 │
     │      3. Redirect to Auth0       │
     ├────────────────────────────────>│
     │                            ┌─────────┐
     │      4. Login (5 options)  │ Auth0   │
     │ <──────────────────────────┤         │
     │                            └─────────┘
     │      5. Authorization Code      │
     ├────────────────────────────────>│
     │                                 │
     │      6. Access Token (JWT)      │
     │ <───────────────────────────────┤
     │                                 │
     │      7. Tool Calls + JWT        │
     │ ──────────────────────────────> │
     │      (Authenticated per user)   │
     │                                 │
     │      8. Tool Responses          │
     │ <─────────────────────────────  │
     │                                 │
```

## Per-User Data Storage

Each authenticated user gets their own data file:

```
/mnt/c/letter-irl/data/
└── accounts/
    ├── auth0|user123.json    # User's credits & orders
    ├── google-oauth2|456.json
    └── github|789.json
```

User ID comes from the Auth0 JWT `sub` claim.

## Environment Variables Reference

```bash
# Server Configuration
LETTER_IRL_HTTP_HOST=0.0.0.0
LETTER_IRL_HTTP_PORT=8788
LETTER_IRL_PUBLIC_BASE_URL=https://your-ngrok-url.ngrok-free.dev

# MCP Endpoints
LETTER_IRL_MCP_PATH=/mcp
LETTER_IRL_SSE_PATH=/mcp
LETTER_IRL_SSE_MESSAGES_PATH=/messages

# Auth0 OAuth
LETTER_IRL_OAUTH_ISSUER=https://dev-ky21dxn3qmi71hjl.us.auth0.com/
LETTER_IRL_OAUTH_AUTH_ENDPOINT=https://dev-ky21dxn3qmi71hjl.us.auth0.com/authorize
LETTER_IRL_OAUTH_TOKEN_ENDPOINT=https://dev-ky21dxn3qmi71hjl.us.auth0.com/oauth/token
LETTER_IRL_OAUTH_JWKS_URI=https://dev-ky21dxn3qmi71hjl.us.auth0.com/.well-known/jwks.json
LETTER_IRL_MCP_RESOURCE=https://YOUR_PUBLIC_HOST/mcp
LETTER_IRL_OAUTH_AUDIENCE=https://YOUR_PUBLIC_HOST/mcp
LETTER_IRL_OAUTH_ALLOWED_ALGORITHMS=RS256
LETTER_IRL_OAUTH_AUDIENCE=https://letter-irl/api
LETTER_IRL_OAUTH_SCOPES=openid,email,profile

# Authentication
LETTER_IRL_REQUIRE_AUTH=true  # Set to false for local testing

# CORS
LETTER_IRL_ALLOWED_ORIGINS=https://chat.openai.com,https://chatgpt.com,https://your-ngrok-url.ngrok-free.dev
LETTER_IRL_ALLOWED_HOSTS=your-ngrok-url.ngrok-free.dev,your-ngrok-url.ngrok-free.dev:443,localhost,127.0.0.1
```

## Next Steps

Now that Auth0 is integrated, you can:

1. **Test all 4 tools** in ChatGPT with real authentication
2. **Add UI widgets** for better visual presentation
3. **Set up proper persistence** (migrate from file-based to database)
4. **Implement print/mail backend** integration
5. **Add credit purchase flow**

## Documentation

- [Auth0 Configuration](../docs/auth0-tenant-configuration.md)
- [OAuth Integration Learnings](../docs/chatgpt-auth0-oauth-learnings.md)
- [Tool Specifications](../docs/tool-apis.md)
- [Functional Requirements](../docs/functional-requirements.md)

## Troubleshooting

### Server won't start
```bash
# Kill any process on port 8788
lsof -ti:8788 | xargs kill -9

# Restart
npm run mcp:http
```

### OAuth fails
1. Check `.env` has correct Auth0 endpoints
2. Verify Auth0 tenant has DCR enabled
3. Ensure all connections are domain-level
4. Check Auth0 logs for errors

### Tools not working
1. Check server logs for authentication errors
2. Verify JWT is being validated (look for "user=" in logs)
3. Ensure user account file is being created in `data/accounts/`

## Success! 🎉

Your Letter IRL MCP server is now fully integrated with Auth0 OAuth. All 4 tools are authenticated per-user, and you can test the complete flow in ChatGPT with 5 different login methods.
