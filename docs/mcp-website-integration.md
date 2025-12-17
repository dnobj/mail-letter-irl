# MCP Integration for letterirl.com Website

**Created:** December 15, 2025
**Status:** Specification for Next.js website implementation
**Related:** PAT authentication feature in `letter-irl` repo

---

## Overview

This document specifies the changes needed in the `letter-irl-website` (Next.js) repository to support MCP client users who want to use Letter IRL with Claude Desktop, Cursor, or other MCP-compatible tools.

## Architecture

```
letterirl.com (Next.js)              api.letterirl.com (MCP Server)
┌─────────────────────────┐          ┌─────────────────────────┐
│                         │          │                         │
│  /how-it-works          │          │  /api/tokens            │
│    └── MCP mention ─────┼──────┐   │    ├── POST (create)    │
│                         │      │   │    ├── GET (list)       │
│  /mcp (PUBLIC)          │      │   │    └── DELETE (revoke)  │
│    ├── What is MCP      │      │   │                         │
│    ├── Setup guide      │      │   │  /mcp (protocol)        │
│    ├── Config snippet   │      │   │                         │
│    └── CTA → dashboard ─┼──┐   │   └─────────────────────────┘
│                         │  │   │
│  /dashboard (AUTH)      │  │   │
│    └── API Tokens ──────┼──┼───┘
│        ├── Create       │  │
│        ├── List         │  │
│        └── Revoke       │  │
│                         │  │
└─────────────────────────┘  │
                             │
    User clicks "Generate Token"
    → Authenticated API call to api.letterirl.com/api/tokens
```

---

## Changes Required

### 1. Add MCP Section to "How It Works" Page

**File:** `app/(marketing)/how-it-works/page.tsx` (or similar)

**Add section at bottom:**

```tsx
<section className="mcp-section">
  <h2>Works with Claude Desktop & Other MCP Clients</h2>
  <p>
    Already use Claude Desktop or Cursor? Letter IRL is also available as an
    MCP (Model Context Protocol) server, letting you send letters from any
    compatible AI assistant.
  </p>
  <Link href="/mcp" className="btn btn-secondary">
    Learn More →
  </Link>
</section>
```

---

### 2. Create Public /mcp Page

**File:** `app/(marketing)/mcp/page.tsx`

**Purpose:** Public landing page for MCP users (SEO-friendly, no auth required)

**Content Structure:**

```markdown
# Send Letters from Claude Desktop & Other MCP Clients

Letter IRL is an MCP server that lets you send real, physical letters from
any AI assistant that supports the Model Context Protocol.

## Supported Clients
- Claude Desktop
- Cursor
- Any MCP-compatible tool

## Quick Start

### Step 1: Create an Account
[Sign Up] or [Sign In] if you already have an account.

### Step 2: Generate an API Token
Go to your [Dashboard → API Tokens](/dashboard/tokens) to create a
Personal Access Token. Your token is only shown once—save it securely!

### Step 3: Configure Your Client

Add this to your client's MCP configuration:

**Claude Desktop config locations:**
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "letter-irl": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://api.letterirl.com/mcp",
        "--header",
        "Authorization: Bearer YOUR_TOKEN_HERE"
      ]
    }
  }
}
```

### Step 4: Restart & Test
Restart your client to load the configuration, then try:
> "Send a thank you letter to John at 123 Main St, New York, NY 10001"

## Pricing
Same as ChatGPT—2 credits per letter. [View pricing →](/pricing)

## Troubleshooting

**Token not working?**
- Verify the token hasn't been revoked in your dashboard
- Check the token starts with `lirl_pat_`

**Configuration errors?**
- Ensure the JSON is valid (no trailing commas)
- Verify the config file location for your OS

**Need help?**
[Contact support](/support)
```

**SEO metadata:**
```tsx
export const metadata = {
  title: 'MCP Setup - Letter IRL',
  description: 'Use Letter IRL with Claude Desktop, Cursor, and other MCP clients. Send real physical letters from any AI assistant.',
  keywords: ['MCP', 'Claude Desktop', 'Cursor', 'AI letters', 'physical mail API'],
};
```

---

### 3. Add API Tokens Section to Dashboard

**File:** `app/(dashboard)/dashboard/page.tsx` or new `app/(dashboard)/dashboard/tokens/page.tsx`

**UI Components Needed:**

#### Token List
```tsx
interface Token {
  tokenId: number;
  name: string;
  tokenPrefix: string;  // Last 4 chars for identification
  status: 'active' | 'revoked';
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

<TokenList>
  <TokenItem>
    <TokenName>Claude Desktop</TokenName>
    <TokenMeta>
      <span>lirl_pat_...a1b2</span>
      <span>Created: Dec 15, 2025</span>
      <span>Last used: Dec 15, 2025</span>
    </TokenMeta>
    <TokenStatus status="active" />
    <RevokeButton onClick={() => revokeToken(tokenId)} />
  </TokenItem>
</TokenList>
```

#### Create Token Form
```tsx
<CreateTokenForm>
  <Input
    label="Token Name"
    placeholder="e.g., Claude Desktop, Cursor"
    maxLength={100}
  />
  <Button type="submit">Generate Token</Button>
</CreateTokenForm>
```

#### New Token Display (shown once after creation)
```tsx
<NewTokenDisplay>
  <Warning>
    Copy this token now—it won't be shown again!
  </Warning>
  <TokenValue>lirl_pat_abc123...</TokenValue>
  <CopyButton onClick={() => copyToClipboard(token)} />
</NewTokenDisplay>
```

---

### 4. API Integration

**Base URL:** `https://api.letterirl.com` (production) or env variable

**Endpoints:**

```typescript
// Create token
POST /api/tokens
Headers: { Authorization: Bearer <jwt> }
Body: { name: string }
Response: {
  token: string,           // Full token (only time it's returned)
  tokenId: number,
  name: string,
  tokenPrefix: string,
  expiresAt: string | null,
  createdAt: string
}

// List tokens
GET /api/tokens
Headers: { Authorization: Bearer <jwt> }
Response: {
  tokens: Array<{
    tokenId: number,
    name: string,
    tokenPrefix: string,
    status: 'active' | 'revoked',
    createdAt: string,
    lastUsedAt: string | null,
    expiresAt: string | null
  }>
}

// Revoke token
DELETE /api/tokens/:tokenId
Headers: { Authorization: Bearer <jwt> }
Response: { success: true }
```

**Note:** Token creation/revocation requires JWT auth (from Auth0 login), not PAT auth. This prevents using a PAT to create more PATs.

---

## File Summary

| Action | File | Description |
|--------|------|-------------|
| Modify | `app/(marketing)/how-it-works/page.tsx` | Add MCP section |
| Create | `app/(marketing)/mcp/page.tsx` | Public MCP setup page |
| Create | `app/(dashboard)/dashboard/tokens/page.tsx` | Token management UI |
| Create | `components/tokens/TokenList.tsx` | Token list component |
| Create | `components/tokens/CreateTokenForm.tsx` | Token creation form |
| Create | `components/tokens/NewTokenDisplay.tsx` | One-time token display |
| Create | `lib/api/tokens.ts` | API client for token endpoints |

---

## Security Considerations

1. **Token displayed once** - After creation, only show `tokenPrefix` (last 4 chars)
2. **JWT required for mutations** - Create/revoke use Auth0 JWT, not PAT
3. **HTTPS only** - All API calls over HTTPS
4. **Copy to clipboard** - Use secure clipboard API with fallback

---

## Testing Checklist

- [ ] /mcp page renders correctly (unauthenticated)
- [ ] /mcp page SEO metadata is correct
- [ ] How It Works page shows MCP section
- [ ] Dashboard token list loads for authenticated user
- [ ] Token creation works and shows token once
- [ ] Token copy to clipboard works
- [ ] Token revocation works
- [ ] Revoked tokens show correct status
- [ ] Empty state shows when no tokens exist
- [ ] Error states handled gracefully

---

## Related Documentation

- [user-stories.md](user-stories.md) - US-MCP-01 through US-MCP-05
- [personas.md](personas.md) - Morgan (MCP Power User)
