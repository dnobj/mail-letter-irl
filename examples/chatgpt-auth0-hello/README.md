# ChatGPT Apps SDK + Auth0 Hello World

A minimal MCP (Model Context Protocol) server demonstrating **ChatGPT Apps SDK** integration with **Auth0 OAuth authentication** and **comprehensive debugging tools**.

## 🎯 What This Does

This is an end-to-end working example that shows:

- ✅ How to implement OAuth 2.1 with PKCE for ChatGPT Apps SDK
- ✅ How to integrate Auth0 as your identity provider
- ✅ How to handle Dynamic Client Registration (DCR)
- ✅ How to debug the OAuth flow with detailed logging
- ✅ How to set up SSE (Server-Sent Events) transport for MCP
- ✅ How to create a simple MCP tool that works with ChatGPT

## 🚀 Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your Auth0 credentials and ngrok URL

# 3. Start ngrok tunnel (in another terminal)
ngrok http 8788

# 4. Run the server
chmod +x start.sh
./start.sh

# 5. Open debug logs in browser
# https://YOUR-NGROK-DOMAIN.ngrok-free.dev/debug/logs

# 6. Add to ChatGPT Developer Mode
# Use manifest URL: https://YOUR-NGROK-DOMAIN.ngrok-free.dev/manifest.json
```

## 📚 Full Setup Guide

See **[SETUP.md](./SETUP.md)** for detailed configuration instructions including:

- Auth0 configuration (API setup, Default Audience, DCR)
- Environment variable setup
- Troubleshooting common issues
- OAuth flow debugging

## 🔍 Debugging Features

This server includes comprehensive debugging tools to help you understand exactly what ChatGPT is doing:

### Web-based Log Viewer

Open `https://YOUR-DOMAIN/debug/logs` to see:

- 🌐 **All HTTP requests** with full headers and body
- 🔐 **OAuth flow steps** (metadata requests, authentication, token validation)
- 🔌 **SSE connection lifecycle** (establishment, session management, closure)
- 🛠️ **MCP tool invocations** with arguments and responses
- ❌ **Errors** with full stack traces and context

Features:
- Auto-refresh every 5 seconds
- Filter by log level (debug, info, warn, error)
- Filter by category (http, oauth, sse, mcp, auth, config)
- Download logs as JSON
- Color-coded for easy reading

## 🏗️ Architecture

```
┌─────────────┐
│  ChatGPT    │
└──────┬──────┘
       │ 1. Fetch manifest.json
       │ 2. Fetch OAuth metadata
       │ 3. Dynamic Client Registration (DCR)
       │ 4. OAuth flow (user login)
       │ 5. SSE connection with Bearer token
       │ 6. MCP tool calls
       ▼
┌─────────────────────────────┐
│  Your MCP Server            │
│  ┌──────────────────────┐   │
│  │ HTTP Server          │   │
│  │ - Manifest endpoint  │   │
│  │ - OAuth metadata     │   │
│  │ - SSE transport      │   │
│  │ - Debug logs         │   │
│  └──────────────────────┘   │
│  ┌──────────────────────┐   │
│  │ Auth Middleware      │   │
│  │ - Token validation   │   │
│  │ - JWKS verification  │   │
│  └──────────────────────┘   │
│  ┌──────────────────────┐   │
│  │ MCP Server           │   │
│  │ - Tool registration  │   │
│  │ - Session management │   │
│  └──────────────────────┘   │
└──────────┬──────────────────┘
           │ JWT validation
           ▼
     ┌──────────┐
     │  Auth0   │
     │ - JWKS   │
     │ - Tokens │
     └──────────┘
```

## 📁 Project Structure

```
chatgpt-auth0-hello/
├── server.ts          # Main HTTP server and MCP setup
├── auth.ts            # Auth0 token validation
├── config.ts          # Environment configuration
├── logger.ts          # Comprehensive logging system
├── package.json       # Dependencies
├── tsconfig.json      # TypeScript configuration
├── .env.example       # Environment variable template
├── start.sh           # Startup script
├── README.md          # This file
└── SETUP.md           # Detailed setup guide
```

## 🛠️ Available Tools

### `hello_world`

A simple greeting tool that demonstrates authentication context.

**Input**:
```json
{
  "name": "Alice"  // optional
}
```

**Output**:
```
Hello, Alice! Authenticated as auth0|xxxxx (alice@example.com).
```

## 🔐 Auth0 Configuration Checklist

- [ ] Created an API in Auth0
- [ ] Set Default Audience in Auth0 tenant settings
- [ ] Verified Dynamic Client Registration endpoint
- [ ] Added ChatGPT callback URLs to allowed list
- [ ] Configured CORS in Auth0
- [ ] Set environment variables in `.env`
- [ ] Verified ngrok tunnel is running
- [ ] Tested OAuth metadata endpoint

## 🐛 Common Issues

See [SETUP.md](./SETUP.md#common-issues-and-solutions) for detailed troubleshooting.

Quick checks:

1. **Token validation fails?** → Check Default Audience in Auth0
2. **PKCE errors?** → Verify OAuth metadata includes `code_challenge_methods_supported: ["S256"]`
3. **DCR fails?** → Check if your Auth0 plan supports Dynamic Client Registration
4. **CORS errors?** → Add ChatGPT origins to ALLOWED_ORIGINS and Auth0 CORS settings
5. **No logs?** → Make sure you're using your ngrok HTTPS URL, not localhost

## 📊 Monitoring

While testing, keep these open:

1. **Debug logs**: `https://YOUR-DOMAIN/debug/logs`
2. **Auth0 logs**: Auth0 Dashboard → Monitoring → Logs
3. **Server console**: Shows color-coded logs in terminal
4. **ChatGPT DevTools**: Browser DevTools while using ChatGPT (Network tab)

## 🎓 Learn More

- [OpenAI Apps SDK Docs](https://developers.openai.com/apps-sdk/)
- [Model Context Protocol](https://spec.modelcontextprotocol.io/)
- [Auth0 OAuth 2.0](https://auth0.com/docs/authenticate/protocols/oauth)
- [OAuth 2.1](https://oauth.net/2.1/)
- [PKCE](https://oauth.net/2/pkce/)

## 📝 License

MIT

## 🤝 Contributing

This is a minimal example for educational purposes. Feel free to extend it with:

- More complex MCP tools
- UI widgets
- Database integration
- Additional authentication providers
- Production deployment guides

## 💬 Support

Having issues?

1. Check the [SETUP.md](./SETUP.md) guide
2. Review your debug logs at `/debug/logs`
3. Check Auth0 logs in the Auth0 Dashboard
4. Verify all environment variables are set correctly
5. Make sure ngrok tunnel is running on HTTPS

## ⭐ Key Features

- **Zero dependencies on external OAuth libraries** - Uses only `jose` for JWT validation
- **Comprehensive logging** - See exactly what ChatGPT is sending
- **Production-ready error handling** - Proper 401 challenges and error responses
- **Configurable** - All settings via environment variables
- **TypeScript** - Full type safety
- **Auto-reload** - Development mode with `tsx watch`
- **Standards-compliant** - Follows OAuth 2.1, OpenID Connect, and MCP specifications

---

Built with ❤️ for the ChatGPT Apps SDK community
