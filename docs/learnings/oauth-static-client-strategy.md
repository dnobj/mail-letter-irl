# OAuth Static Client Strategy

**Date:** December 2025
**Issue:** #20 - ChatGPT creating duplicate Auth0 clients via DCR
**Status:** Resolved

## Overview

Letter IRL uses a **pre-registered static client** for MCP OAuth authentication. This is the MCP-recommended approach as of November 2025, not a workaround.

## Background: Why Static Clients?

ChatGPT (and other MCP clients) originally used Auth0's Dynamic Client Registration (DCR) endpoint, which created a new client on every session. This resulted in:

- 17 duplicate "ChatGPT" third-party clients in our tenant
- Risk of hitting Auth0 entity limits (10 apps for development tenants)
- Cluttered tenant management

## MCP Specification (November 2025)

The MCP Authorization Specification now recommends this priority order:

1. **Pre-registered client (static)** - PREFERRED
2. **CIMD (Client ID Metadata Documents)** - New standard
3. **DCR (Dynamic Client Registration)** - Fallback only, "for backwards compatibility"

### Why the Change?

From the MCP specification authors:

> "DCR introduces massive complexity and risk... authorization servers faced unbounded database growth"

The static client approach is now the **recommended standard**, not a hack or workaround.

### Authoritative Sources

- [MCP Authorization Specification](https://modelcontextprotocol.io/specification/draft/basic/authorization)
- [MCP Blog: Evolving OAuth Client Registration](https://blog.modelcontextprotocol.io/posts/client_registration/)
- [OpenAI Apps SDK Authentication](https://developers.openai.com/apps-sdk/build/auth/)
- [MCP Auth Spec Update](https://aaronparecki.com/2025/11/25/1/mcp-authorization-spec-update)
- [OpenAI Community Thread](https://community.openai.com/t/oauth-client-id-is-no-longer-optional/1367103)

### OpenAI Apps SDK Status

- Currently uses DCR but transitioning to CIMD
- Static clients are fully supported and preferred
- Our implementation is future-proof

## Solution Implemented

Instead of forwarding to Auth0's DCR, we implemented our own `/oauth/register` endpoint that returns a pre-provisioned static client.

### Changes Made

| File | Change |
|------|--------|
| `src/auth/metadata.ts` | Changed `registration_endpoint` to `${baseUrl}/oauth/register` |
| `src/mcp/httpServer.ts` | Added `/oauth/register` handler returning static client |
| Railway env vars | Added `CHATGPT_STATIC_CLIENT_ID` |

### How It Works

1. ChatGPT fetches `/.well-known/openid-configuration`
2. Gets `registration_endpoint: https://api.letterirl.com/oauth/register` (our server)
3. Calls `POST /oauth/register`
4. We return the same static `client_id` every time (RFC 7591 compliant response)
5. ChatGPT uses that client_id for OAuth flow
6. No new Auth0 clients created!

### Static Client Configuration

The static "ChatGPT MCP" client in Auth0:
- **Client ID:** `2XHZba1RfkpWNgpHBYPpgy61A0y93R1q`
- **Type:** First-party application
- **Auth Method:** `none` (public client, no secret)
- **Grant Types:** `authorization_code`, `refresh_token`
- **Callbacks:**
  - `https://chat.openai.com/aip/auth/callback`
  - `https://chatgpt.com/connector_platform_oauth_redirect`
  - `http://localhost:18883/oauth/callback` (Claude Desktop mcp-remote)

## What Still Works

- User identity isolation (different JWT `sub` claims per user)
- Session management (separate MCP server instances)
- Token validation (Auth0 default audience configured)
- PAT authentication (unaffected)
- Website OAuth (uses separate client)
- Claude Desktop (supports both OAuth and PAT)

## Future Considerations

When OpenAI fully adopts CIMD:
1. Clients will use stable identity URLs instead of DCR
2. Our static client approach remains compatible
3. We may eventually remove the `/oauth/register` endpoint if no longer needed

## Testing

Tests added in `tests/unit/auth/dcrEndpoint.test.ts`:
- RFC 7591 response format validation
- Static client behavior (same ID for multiple requests)
- Error handling when not configured
- Duplicate prevention verification
- MCP client compatibility (ChatGPT, Claude Desktop)
