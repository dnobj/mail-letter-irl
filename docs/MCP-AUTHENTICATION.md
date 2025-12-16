# MCP Authentication Guide

**Last Updated:** December 16, 2025

---

## Overview

Letter IRL supports two authentication methods for MCP clients:

| Method | Use Case | Setup Complexity |
|--------|----------|------------------|
| **OAuth (Auth0)** | Claude Desktop | Simple - just add config |
| **Personal Access Token (PAT)** | Custom agents, headless environments | Requires token generation |

---

## Claude Desktop: OAuth (Recommended)

Claude Desktop supports OAuth authentication via the `mcp-remote` package. This is the recommended approach because:

- No tokens to manage
- Authenticates via browser (same as web login)
- Session persists across restarts

### Configuration

**Windows:**
```json
{
  "mcpServers": {
    "letter-irl": {
      "command": "npx.cmd",
      "args": ["-y", "mcp-remote", "https://api.letterirl.com/mcp"]
    }
  }
}
```

**macOS / Linux:**
```json
{
  "mcpServers": {
    "letter-irl": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://api.letterirl.com/mcp"]
    }
  }
}
```

### Config File Locations

| OS | Path |
|----|------|
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Linux | `~/.config/claude/claude_desktop_config.json` |

### How It Works

1. Add the config and restart Claude Desktop
2. A browser window opens asking you to log in to Letter IRL
3. Complete authentication (same Auth0 login as the web)
4. Claude Desktop is now connected

---

## Custom Agents: Personal Access Token (PAT)

For MCP clients that don't support OAuth (custom agents, headless environments, automated workflows), use a Personal Access Token.

### When to Use PAT

- Building autonomous AI agents
- Headless/server environments (no browser available)
- Custom MCP client implementations
- Testing and development

### Getting a Token

1. Log in to [letterirl.com/dashboard/tokens](https://letterirl.com/dashboard/tokens)
2. Enter a descriptive name (e.g., "My Custom Agent")
3. Click "Generate Token"
4. Copy the token immediately (it won't be shown again)

### Token Format

```
lirl_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### Configuration with PAT

```json
{
  "mcpServers": {
    "letter-irl": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://api.letterirl.com/mcp",
        "--header",
        "Authorization:${AUTH_HEADER}"
      ],
      "env": {
        "AUTH_HEADER": "Bearer lirl_pat_your_token_here"
      }
    }
  }
}
```

**Note:** Use environment variables to avoid Windows space-handling issues. No space after `Authorization:`.

### Token Security

- Tokens are hashed (bcrypt) - we never store the raw token
- Shown only once at creation
- Can be revoked anytime from the dashboard
- Scope is per-user (same permissions as OAuth login)

---

## Decision Guide

```
Do you have a browser available for login?
├── Yes → Use OAuth (Claude Desktop, desktop apps)
└── No → Use PAT (agents, servers, automation)

Is this Claude Desktop?
├── Yes → Use OAuth (simpler setup)
└── No → Check if your client supports OAuth
    ├── Yes → OAuth preferred
    └── No → Use PAT
```

---

## See Also

- [Claude Desktop MCP Learnings](learnings/claude-desktop-mcp.md) - Detailed troubleshooting
- [PERSONAS.md](PERSONAS.md) - Morgan (MCP Power User) and Jordan (Agent Builder)
- [USER-STORIES.md](USER-STORIES.md) - US-MCP-01 through US-MCP-05
