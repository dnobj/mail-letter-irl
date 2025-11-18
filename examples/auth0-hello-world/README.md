# Auth0 + OpenAI Apps SDK Hello World

This sample shows the smallest possible MCP server secured by Auth0 and reachable from ChatGPT Developer Mode. It exposes a single `hello_world` tool over the SSE transport and advertises OAuth metadata via the MCP manifest.

## 1. Prerequisites
- Node.js 18+
- Auth0 tenant with Universal Login enabled
- ngrok (or another HTTPS tunnel) if you want to connect from ChatGPT

## 2. Configure Auth0
1. **Create an API** (Applications → APIs → Create API)
   - Identifier: `https://your-app.example.com/mcp`
   - Algorithm: RS256
2. **Enable Dynamic Client Registration** (Tenant Settings → Advanced → toggle on).
3. **Set the Default Audience** to the API identifier so Auth0 issues RS256 access tokens.
4. **Note these endpoints** from the Auth0 “Discovery” tab:
   - Issuer: `https://<tenant>.us.auth0.com/`
   - Authorization endpoint, token endpoint, JWKS URL, registration endpoint.

## 3. Environment variables
Create a `.env` file in this folder:
```bash
cp .env.example .env
```
Fill in the values (replace with your tenant info and ngrok URL once you tunnel):
```
SERVER_HOST=0.0.0.0
SERVER_PORT=8733
PUBLIC_BASE_URL=https://<ngrok-domain>/
ALLOWED_ORIGINS=https://chat.openai.com,https://chatgpt.com
ALLOWED_HOSTS=<ngrok-domain>,<ngrok-domain>:443

AUTH0_ISSUER=https://dev-abc123.us.auth0.com/
AUTH0_AUTHORIZATION_ENDPOINT=https://dev-abc123.us.auth0.com/authorize
AUTH0_TOKEN_ENDPOINT=https://dev-abc123.us.auth0.com/oauth/token
AUTH0_JWKS_URI=https://dev-abc123.us.auth0.com/.well-known/jwks.json
AUTH0_REGISTRATION_ENDPOINT=https://dev-abc123.us.auth0.com/oauth/register
AUTH0_AUDIENCE=https://your-app.example.com/mcp
AUTH0_SCOPES=openid,email,profile
```

## 4. Install & run locally
```bash
npm install
npm run dev
```
- Manifest: `http://localhost:8733/manifest.json`
- SSE stream: `http://localhost:8733/mcp/sse`

## 5. Tunnel for ChatGPT
```bash
ngrok http 8733
```
Update `PUBLIC_BASE_URL`, `ALLOWED_HOSTS`, and `ALLOWED_ORIGINS` to reflect the ngrok domain, then restart `npm run dev` so the manifest advertises the HTTPS URLs.

## 6. Add connector in ChatGPT Developer Mode
1. Settings → Connectors → Create → Custom.
2. MCP Server URL: `https://<ngrok-domain>/mcp/sse`.
3. Authentication: **OAuth**. ChatGPT opens Auth0 Universal Login; sign in.
4. After creation, invoke `hello_world` by asking something like “Use hello world tool for Sam.”

If authentication fails, hit:
```
https://<ngrok-domain>/.well-known/oauth-authorization-server
```
to double-check the metadata.

## 7. Next steps
- Add more tools by registering them in `src/server.ts`.
- Replace the hello-world response with calls to internal services. Each request includes the validated Auth0 subject so you can enforce per-user policies.
