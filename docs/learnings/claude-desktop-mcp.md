# Claude Desktop MCP Connection Learnings

**Created:** December 16, 2025
**Status:** Validated and working
**Related:** MCP integration, Auth0 OAuth, PAT authentication

---

## Overview

This document captures learnings from implementing and debugging the connection between Claude Desktop and Letter IRL's MCP server.

## Key Finding: OAuth vs PAT Authentication

**OAuth is the recommended approach for Claude Desktop**, not Personal Access Tokens (PAT).

### Why OAuth Works Better

1. **Native Support**: The `mcp-remote` package natively supports OAuth and automatically detects OAuth metadata endpoints (`.well-known/oauth-authorization-server`)

2. **Simpler Configuration**: No need to manage tokens or include `--header` arguments

3. **Better UX**: Users authenticate once via browser, and the session persists

### Why PAT Had Issues

1. **OAuth Discovery**: Even when providing a Bearer token via `--header`, `mcp-remote` still detects the OAuth metadata and attempts OAuth flow

2. **Windows Space Handling**: Args with spaces (like `Authorization: Bearer xxx`) get mangled on Windows

3. **Path Issues**: Windows paths with spaces (`C:\Program Files\...`) cause command execution failures

---

## Working Configuration

### Windows

```json
{
  "mcpServers": {
    "letter-irl": {
      "command": "npx.cmd",
      "args": [
        "-y",
        "mcp-remote",
        "https://api.letterirl.com/mcp"
      ]
    }
  }
}
```

**Key points:**
- Use `npx.cmd` (not `npx`) to avoid path resolution issues
- Include `-y` flag to auto-accept npx package installation
- No `--header` needed - OAuth handles authentication

### macOS / Linux

```json
{
  "mcpServers": {
    "letter-irl": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://api.letterirl.com/mcp"
      ]
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

---

## Auth0 Configuration Required

For OAuth to work, the Auth0 application needs the `mcp-remote` callback URL:

**Application:** MCP CLI Proxy (`aT9yG22VMAX13WN6snrQs3mj17g3os6Q`)

**Required Callback URL:**
```
http://localhost:18883/oauth/callback
```

The port (18883) is used by `mcp-remote` for the OAuth callback server.

---

## Common Issues and Solutions

### 1. "C:\Program" is not recognized

**Cause:** Windows path with spaces not being quoted properly by Claude Desktop

**Solution:** Use `npx.cmd` instead of `npx` in the command field

### 2. "Invalid authorization code" Error

**Cause:** Stale OAuth state in mcp-remote cache

**Solution:** Clear the cache and restart:
```powershell
# Windows PowerShell
Remove-Item -Recurse -Force "$env:USERPROFILE\.mcp-auth"
```
```bash
# macOS/Linux
rm -rf ~/.mcp-auth
```

### 3. OAuth Login Window Doesn't Appear

**Cause:** Browser blocking pop-ups or Claude Desktop not fully restarted

**Solution:**
- Check browser isn't blocking pop-ups
- Fully quit Claude Desktop (check system tray on Windows)
- Restart Claude Desktop

### 4. Server Disconnected After Auth

**Cause:** Auth0 callback URL not configured

**Solution:** Add `http://localhost:18883/oauth/callback` to Auth0 application's Allowed Callback URLs

---

## Log File Locations

Claude Desktop MCP logs are useful for debugging:

**Windows:**
```
%APPDATA%\Claude\logs\mcp-server-letter-irl.log
%APPDATA%\Claude\logs\mcp.log
```

**macOS:**
```
~/Library/Logs/Claude/mcp-server-letter-irl.log
~/Library/Logs/Claude/mcp.log
```

---

## Architecture

```
┌─────────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│   Claude Desktop    │     │    mcp-remote    │     │  api.letterirl.com  │
│                     │     │    (npm pkg)     │     │                     │
│  claude_desktop_    │────▶│                  │────▶│  /mcp endpoint      │
│  config.json        │     │  OAuth flow via  │     │                     │
│                     │     │  localhost:18883 │     │  /.well-known/      │
└─────────────────────┘     └──────────────────┘     │  oauth-*            │
                                    │                └─────────────────────┘
                                    │
                                    ▼
                            ┌──────────────────┐
                            │      Auth0       │
                            │                  │
                            │  OAuth provider  │
                            └──────────────────┘
```

---

## When to Use PAT Instead

Personal Access Tokens may still be needed for:

1. **MCP clients without OAuth support** - Some clients may not implement the OAuth discovery flow

2. **Automated/headless environments** - Where browser-based OAuth isn't possible

3. **Testing/development** - When you need to quickly test without OAuth flow

### PAT Configuration (if needed)

```json
{
  "mcpServers": {
    "letter-irl": {
      "command": "npx.cmd",
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

**Note:** Use env variable to avoid Windows space-handling bugs. No space after `Authorization:`.

---

## References

- [mcp-remote npm package](https://www.npmjs.com/package/mcp-remote)
- [mcp-remote GitHub](https://github.com/geelen/mcp-remote)
- [MCP Authorization Specification](https://modelcontextprotocol.io/specification/draft/basic/authorization)
- [Claude Desktop MCP Documentation](https://modelcontextprotocol.io/docs/tools/debugging)
