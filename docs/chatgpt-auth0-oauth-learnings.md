# ChatGPT Apps SDK with Auth0 OAuth: Implementation Learnings

**Date**: November 14, 2025
**Status**: ✅ Working Implementation
**Example**: `examples/chatgpt-auth0-hello/`

## Executive Summary

Successfully implemented a Model Context Protocol (MCP) server with Auth0 OAuth authentication that connects to ChatGPT Apps SDK Developer Mode. This document captures the critical learnings, technical breakthroughs, and configuration requirements discovered during implementation.

## The Challenge

Build an end-to-end MCP server with Auth0 OAuth that:
- Authenticates ChatGPT users via Auth0
- Supports Dynamic Client Registration (RFC 7591) - **mandatory** for ChatGPT
- Works with ChatGPT's MCP connector in Developer Mode
- Provides comprehensive debugging since OpenAI offers limited troubleshooting tools

## Critical Discoveries

### 1. **Streamable HTTP is Essential** 🎯

**The Breakthrough**: ChatGPT prefers the newer **Streamable HTTP** transport over legacy SSE.

**What We Observed**:
```
POST /mcp → 404 (server only had SSE)
GET /mcp  → 200 (ChatGPT falls back to SSE)
```

But even with SSE working:
- SSE connection established ✅
- Initialize message received ✅
- **No response sent back** ❌
- ChatGPT times out after ~60 seconds

**The Solution**:
Implement **both** Streamable HTTP (preferred) and SSE (fallback) at the same endpoint:

```typescript
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

// Handle both POST (Streamable HTTP) and GET (SSE)
if (req.method === 'POST') {
  transport = new StreamableHTTPServerTransport(res, options);
} else {
  transport = new SSEServerTransport('/messages', res, options);
}
```

**Key Insight**: The official MCP SDK examples still show SSE, but ChatGPT Apps SDK documentation recommends Streamable HTTP. Always implement both for maximum compatibility.

### 2. **Dynamic Client Registration (DCR) is Mandatory**

ChatGPT **requires** RFC 7591 Dynamic Client Registration. Static OAuth clients will not work.

**Auth0 Configuration**:
1. Dashboard → Settings → Advanced
2. Enable **"OIDC Dynamic Application Registration"**
3. Verify endpoint: `https://YOUR-TENANT.auth0.com/oidc/register`

**Manifest Configuration**:
```json
{
  "auth": {
    "type": "oauth",
    "scopes": ["openid", "email", "profile"],
    "authorizationServer": "https://your-server/.well-known/oauth-authorization-server"
  }
}
```

**OAuth Discovery Metadata**:
```javascript
{
  "registration_endpoint": "https://dev-xxx.auth0.com/oidc/register",
  "grant_types_supported": ["authorization_code"],
  "code_challenge_methods_supported": ["S256"], // PKCE required
  // ... other fields
}
```

### 3. **Domain-Level Connections for Third-Party Clients** 🔑

**The Problem**:
After enabling DCR, got error: `"no connections enabled for the client"`

**Root Cause**:
Dynamically registered clients (third-party applications) don't automatically inherit database connections. Auth0's UI shows the error:
```
"Unexpected failure trying to update the connection"
```

This is a **known Auth0 limitation** - you cannot enable connections for third-party clients via the UI.

**The Solution**:
Use Auth0 Management API to make the connection **domain-level**:

```bash
curl -X PATCH "https://YOUR-TENANT.auth0.com/api/v2/connections/CONN_ID" \
  -H "Authorization: Bearer MGMT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"is_domain_connection": true}'
```

**What This Does**:
- Sets `is_domain_connection: true` on the database connection
- Makes it automatically available to **all** third-party/dynamically registered clients
- No need to manually enable per-client

**Critical Auth0 Settings**:
1. **Default Audience**: Settings → General → API Authorization Settings → Set to your API identifier (e.g., `https://letter-irl/api`)
2. **Domain-Level Connection**: Use Management API to set `is_domain_connection: true` on `Username-Password-Authentication`
3. **DCR Enabled**: Settings → Advanced → OIDC Dynamic Application Registration → ON

### 4. **ChatGPT Doesn't Send `audience` Parameter**

**The Issue**:
Auth0 requires an `audience` parameter to issue access tokens for APIs, but ChatGPT's OAuth flow doesn't include it.

**The Workaround**:
Configure **Default Audience** in Auth0 tenant settings:
- Location: Dashboard → Settings → General → "API Authorization Settings"
- Set to your API identifier: `https://your-api/identifier`
- This audience is automatically applied when not explicitly requested

### 5. **Per-Session MCP Server Instances Required**

**What Didn't Work**:
```typescript
// ❌ Single shared server for all connections
const sharedServer = new McpServer({ name: 'my-server', version: '1.0.0' });

app.get('/mcp', async (req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  await sharedServer.connect(transport); // Problems!
});
```

**What Works**:
```typescript
// ✅ New server instance per connection
app.get('/mcp', async (req, res) => {
  const sessionServer = new McpServer({ name: 'my-server', version: '1.0.0' });
  const transport = new SSEServerTransport('/messages', res);
  await sessionServer.connect(transport);

  sessions.set(transport.sessionId, { server: sessionServer, transport });
});
```

**Why**: The MCP SDK maintains internal state per server instance. Sharing one server across multiple transports causes response routing issues.

## Technical Implementation Details

### Architecture

```
┌─────────────┐
│   ChatGPT   │
└──────┬──────┘
       │ 1. POST /mcp (Streamable HTTP preferred)
       │    or GET /mcp (SSE fallback)
       ▼
┌──────────────────────────┐
│  MCP Server (Node.js)    │
│  - Auth0 JWT validation  │
│  - StreamableHTTP/SSE    │
│  - Per-session servers   │
└──────┬───────────────────┘
       │ 2. Validate JWT via JWKS
       ▼
┌──────────────────────────┐
│       Auth0 Tenant       │
│  - DCR enabled           │
│  - Domain-level conn     │
│  - Default audience      │
└──────────────────────────┘
```

### JWT Validation Flow

```typescript
import { jwtVerify, createRemoteJWKSet } from 'jose';

const JWKS = createRemoteJWKSet(new URL(jwksUri));

async function authenticateRequest(req, res, config) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.replace(/^Bearer\s+/i, '');

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: config.auth0.issuer,
      audience: config.auth0.audience
    });

    return {
      userId: payload.sub,
      email: payload.email,
      scopes: payload.scope?.split(' ') || []
    };
  } catch (error) {
    res.writeHead(401, {
      'WWW-Authenticate': `Bearer error="invalid_token", error_description="${error.message}"`
    });
    res.end();
    return null;
  }
}
```

### Dual-Protocol MCP Endpoint

```typescript
async function handleMcpConnection(req, res, requestId) {
  const isStreamableHttp = req.method === 'POST';
  const protocol = isStreamableHttp ? 'Streamable HTTP' : 'SSE';

  // Authenticate
  const authInfo = await authenticateRequest(req, res, config, requestId);
  if (!authInfo) return;

  // Create appropriate transport
  let transport;
  if (isStreamableHttp) {
    transport = new StreamableHTTPServerTransport(res, {
      allowedHosts: config.allowedHosts,
      allowedOrigins: config.allowedOrigins,
      enableDnsRebindingProtection: true
    });
  } else {
    transport = new SSEServerTransport('/messages', res, {
      allowedHosts: config.allowedHosts,
      allowedOrigins: config.allowedOrigins,
      enableDnsRebindingProtection: true
    });
  }

  // Create and connect MCP server
  const sessionServer = new McpServer({ name: 'my-server', version: '1.0.0' });
  await sessionServer.connect(transport);

  // For Streamable HTTP, handle the POST request
  if (isStreamableHttp) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    await new Promise(resolve => req.on('end', resolve));

    const parsedBody = body ? JSON.parse(body) : undefined;
    await transport.handleRequest(req, res, parsedBody);
  }

  // Store session
  sessions.set(transport.sessionId, { server: sessionServer, transport, authInfo });
}
```

### OAuth Discovery Endpoints

Required `.well-known` endpoints for OAuth discovery:

```typescript
// /.well-known/oauth-authorization-server
{
  "issuer": "https://dev-xxx.auth0.com/",
  "authorization_endpoint": "https://dev-xxx.auth0.com/authorize",
  "token_endpoint": "https://dev-xxx.auth0.com/oauth/token",
  "jwks_uri": "https://dev-xxx.auth0.com/.well-known/jwks.json",
  "registration_endpoint": "https://dev-xxx.auth0.com/oidc/register",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code"],
  "code_challenge_methods_supported": ["S256"],
  "scopes_supported": ["openid", "email", "profile"],
  "token_endpoint_auth_methods_supported": ["client_secret_post", "client_secret_basic", "none"]
}

// /.well-known/oauth-protected-resource
{
  "resource": "https://your-server.com",
  "authorization_servers": ["https://dev-xxx.auth0.com/"],
  "jwks_uri": "https://dev-xxx.auth0.com/.well-known/jwks.json",
  "scopes_supported": ["openid", "email", "profile"]
}
```

## Common Pitfalls & Solutions

### Pitfall 1: "dynamic client registration is disabled"
**Solution**: Enable DCR in Auth0 Settings → Advanced → OIDC Dynamic Application Registration

### Pitfall 2: "no connections enabled for the client"
**Solution**: Set `is_domain_connection: true` via Management API. Cannot be done via UI for third-party clients.

### Pitfall 3: SSE transport works but no response sent
**Solution**: Implement Streamable HTTP transport. ChatGPT prefers it over SSE.

### Pitfall 4: "Bad HTTP authentication header format"
**Solution**: Ensure Management API token is properly trimmed of whitespace when reading from user input.

### Pitfall 5: "third party clients are only allowed on domain level connections"
**Solution**: This error means you tried to add a third-party client to `enabled_clients` array. Instead, set `is_domain_connection: true`.

### Pitfall 6: Connection ID not matching connection name
**Solution**: Use Management API to get connection ID by name:
```bash
curl "https://YOUR-TENANT.auth0.com/api/v2/connections" \
  -H "Authorization: Bearer TOKEN" | jq '.[] | select(.name == "Username-Password-Authentication") | .id'
```

### Pitfall 7: CORS errors from ChatGPT
**Solution**: Add to allowed origins:
```typescript
allowedOrigins: [
  'https://chat.openai.com',
  'https://chatgpt.com',
  'https://your-ngrok-url.ngrok-free.dev'
]
```

## Debugging Tools & Techniques

### 1. Comprehensive Logging System

Built a custom logger that captures all requests with categories:

```typescript
export type LogCategory = 'http' | 'oauth' | 'sse' | 'mcp' | 'auth' | 'error' | 'config';

logger.info('mcp', 'Connection requested', { method: req.method, accept: req.headers.accept });
logger.debug('auth', 'JWT verification successful', { userId: payload.sub });
logger.error('sse', 'Failed to establish session', { error: err.message, stack: err.stack });
```

### 2. Web-Based Debug Log Viewer

Created `/debug/logs` endpoint with:
- Real-time log viewing with auto-refresh
- Filtering by level (debug/info/warn/error) and category
- JSON export for analysis
- Circular buffer (1000 entries) to prevent memory issues

### 3. Response Stream Monitoring

To debug why responses weren't being sent:

```typescript
const originalWrite = res.write.bind(res);
res.write = function(...args) {
  logger.debug('sse', 'SSE stream writing data', {
    dataPreview: typeof args[0] === 'string' ? args[0].substring(0, 200) : '<binary>'
  });
  return originalWrite(...args);
};
```

This revealed that SSE transport never called `res.write()` for responses.

### 4. Auth0 Logs

**Location**: Auth0 Dashboard → Monitoring → Logs

**Key log types**:
- `seacft` - Successful Exchange (Authorization Code for Access Token)
- `feacft` - Failed Exchange
- `feccft` - Failed Exchange (Client Credentials)

**What to check**:
- User agent should be `Python aiohttp 3.11.18 / Other 0.0.0` (ChatGPT)
- Client ID should match dynamically registered client
- Look for "no connections enabled" in error descriptions

### 5. Management API Scripts

Created helper scripts to inspect and modify Auth0 configuration:

```bash
# Get connection details
./check-connection-settings.sh YOUR_MGMT_TOKEN

# Enable domain-level connection
./enable-domain-connection.sh YOUR_MGMT_TOKEN

# Enable connection for specific client (not needed with domain-level)
./enable-connection-for-client.sh YOUR_MGMT_TOKEN CLIENT_ID
```

## Protocol Comparison: Streamable HTTP vs SSE

| Feature | Streamable HTTP | SSE (Legacy) |
|---------|----------------|--------------|
| **Request Type** | POST | GET (stream) + POST (messages) |
| **Endpoints** | Single `/mcp` endpoint | Separate `/sse` and `/messages` |
| **Response** | Direct HTTP response | Server-Sent Events stream |
| **Stateless** | ✅ Yes | ❌ No (requires persistent connection) |
| **Resumable** | ✅ Yes | ❌ No |
| **ChatGPT Preference** | ✅ Preferred | ⚠️ Fallback |
| **Complexity** | Lower | Higher |
| **SDK Support** | `StreamableHTTPServerTransport` | `SSEServerTransport` |

## Environment Variables Required

```bash
# Server
SERVER_HOST=0.0.0.0
SERVER_PORT=8788
PUBLIC_BASE_URL=https://your-ngrok-url.ngrok-free.dev

# MCP Endpoint
SSE_PATH=/mcp
SSE_MESSAGES_PATH=/messages

# CORS
ALLOWED_ORIGINS=https://chat.openai.com,https://chatgpt.com,https://your-ngrok-url.ngrok-free.dev
ALLOWED_HOSTS=your-ngrok-url.ngrok-free.dev,localhost,127.0.0.1

# Auth0
AUTH0_ISSUER=https://dev-xxx.us.auth0.com/
AUTH0_AUTHORIZATION_ENDPOINT=https://dev-xxx.us.auth0.com/authorize
AUTH0_TOKEN_ENDPOINT=https://dev-xxx.us.auth0.com/oauth/token
AUTH0_JWKS_URI=https://dev-xxx.us.auth0.com/.well-known/jwks.json
AUTH0_REGISTRATION_ENDPOINT=https://dev-xxx.us.auth0.com/oidc/register
AUTH0_AUDIENCE=https://your-api/identifier
AUTH0_SCOPES=openid,email,profile
```

## Testing Checklist

- [ ] DCR enabled in Auth0
- [ ] Default Audience set in Auth0 General settings
- [ ] Database connection is domain-level (`is_domain_connection: true`)
- [ ] Management API token has permissions: `read:connections`, `update:connections`
- [ ] ngrok tunnel running and HTTPS accessible
- [ ] Server starts without errors
- [ ] `/debug/logs` accessible and showing logs
- [ ] `/.well-known/oauth-authorization-server` returns valid JSON
- [ ] `/.well-known/oauth-protected-resource` returns valid JSON
- [ ] POST /mcp returns HTTP 200 (not 404)
- [ ] Auth0 user exists in database connection
- [ ] ChatGPT Developer Mode enabled
- [ ] Connector added with MCP endpoint URL
- [ ] Auth0 login page appears
- [ ] After authentication, connector shows as connected
- [ ] Tool appears in ChatGPT's available actions
- [ ] Tool execution returns expected result

## Success Metrics

When everything works correctly, you should see:

1. **ChatGPT logs**:
   ```
   "hello world 712 test oauth is now connected"
   ```

2. **Server logs**:
   ```
   [INFO] [mcp] Streamable HTTP connection requested
   [DEBUG] [auth] JWT verification successful
   [DEBUG] [mcp] MCP server connected to transport
   [INFO] [mcp] ✅ MCP session established
   [INFO] [mcp] Tool invoked: hello_world
   ```

3. **Auth0 logs**:
   ```
   type: seacft (Successful Exchange - Authorization Code for Access Token)
   client_name: ChatGPT
   user_name: your@email.com
   ```

## Dependencies

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.21.1",
    "jose": "^6.1.0",
    "dotenv": "^17.2.3"
  },
  "devDependencies": {
    "@types/node": "^20.10.0",
    "tsx": "^4.7.0",
    "typescript": "^5.3.3"
  }
}
```

## References

- **MCP Specification**: https://modelcontextprotocol.io/specification
- **ChatGPT Apps SDK**: https://developers.openai.com/apps-sdk/
- **Auth0 DCR Docs**: https://auth0.com/docs/get-started/applications/dynamic-client-registration
- **RFC 7591 (DCR)**: https://datatracker.ietf.org/doc/html/rfc7591
- **OAuth 2.1**: https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-10
- **Working Example**: `examples/chatgpt-auth0-hello/`

## Next Steps

Potential improvements:
1. Implement token refresh logic for long-lived sessions
2. Add rate limiting per authenticated user
3. Implement user-specific tool permissions
4. Add metrics/analytics for tool usage
5. Support multiple OAuth providers (Google, GitHub, etc.)
6. Implement webhook for user provisioning
7. Add session management UI
8. Support for MCP resources and prompts (not just tools)

## Conclusion

The key to success was:
1. **Implementing Streamable HTTP** - Critical for ChatGPT compatibility
2. **Proper Auth0 DCR configuration** - Enable tenant-wide, set default audience
3. **Domain-level connections** - Use Management API, not UI
4. **Per-session MCP servers** - Avoid shared server instances
5. **Comprehensive debugging** - Built custom logging since OpenAI provides limited tools

With these learnings, you can build production-ready MCP servers with OAuth authentication for ChatGPT Apps SDK.

---

**Implementation Date**: November 14, 2025
**Working Example**: `examples/chatgpt-auth0-hello/`
**Status**: ✅ Fully Functional
