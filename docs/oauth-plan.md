# OAuth & Identity Plan (Google Cloud + Firestore)

> Superseded for ChatGPT MCP authentication by
> `docs/oauth-cimd-migration-plan.md`. The active architecture is Auth0 manual
> public CIMD, authorization code + PKCE S256, no client secret, a dedicated
> exact `/mcp` audience, and `mail:read`/`mail:draft`/`mail:send`. DCR and the
> static registration route are temporary rollback compatibility only.
> Website/REST and Claude/PAT authentication remain separate.

This plan outlines how to add per-user identity using Auth0 (for RFC 7591 support) while keeping Firestore and the rest of the stack on Google Cloud. The goal is to let ChatGPT authenticate each end user, so Letter IRL can map tool calls to individual Firestore accounts.

## 1. Google Cloud Setup
1. Create (or reuse) a Google Cloud project.
2. Enable **Firestore** (Native mode) for persistent storage of user accounts, credit balances, and letter jobs.
3. Enable **Identity Platform** only if you need Firebase Auth for other services (not used for ChatGPT OAuth anymore).
4. Create a service account with Firestore access for backend workers (job queue, admin tools).

## 2. Configure Auth0 Tenant, App, and API
1. Create an Auth0 tenant (e.g., `dev-ky21dxn3qmi71hjl.us.auth0.com`). That domain exposes the required `.well-known` metadata and RFC 7591 registration endpoint out of the box.citeauth0.com/docs/get-started/auth0-mcp-server
2. Applications → “Regular Web Application” → create “Mail Letter IRL” with callback URLs `https://chat.openai.com/aip/auth/callback` and `https://chatgpt.com/connector_platform_oauth_redirect`, plus allowed origins `https://chat.openai.com`, `https://chatgpt.com`.
3. Applications → **APIs** → create “Letter IRL API” with identifier `https://letter-irl/api` and scopes (`openid`, `profile`, `email`, plus any custom ones such as `letters:send`). Auth0 automatically creates a test application that you can ignore.
4. Note the tenant’s issuer, jwks, token, auth, and registration URLs:
   - Issuer: `https://<tenant>.us.auth0.com/`
   - Authorization endpoint: `https://<tenant>.us.auth0.com/authorize`
   - Token endpoint: `https://<tenant>.us.auth0.com/oauth/token`
   - JWKS: `https://<tenant>.us.auth0.com/.well-known/jwks.json`
   - Registration endpoint: `https://<tenant>.us.auth0.com/oauth/register`

## 3. Expose MCP Auth Metadata
ChatGPT expects your MCP server to host:
- `/.well-known/oauth-authorization-server` (or `openid-configuration`) describing the authorization and token endpoints.
- `/.well-known/oauth-protected-resource` describing resource server metadata.

Action items:
1. `src/auth/metadata.ts` now serves Auth0 discovery info, including `registration_endpoint` so ChatGPT can auto-register clients.
2. `src/mcp/httpServer.ts` routes `.well-known` and `/oauth/register` to Auth0’s issuer (no more Google stub once ChatGPT uses Auth0 directly).
3. Required env vars:
   - `LETTER_IRL_OAUTH_ISSUER`, `LETTER_IRL_OAUTH_JWKS_URI`, `LETTER_IRL_OAUTH_AUTH_ENDPOINT`, `LETTER_IRL_OAUTH_TOKEN_ENDPOINT`
   - `LETTER_IRL_OAUTH_SCOPES` (`openid email profile`)
   - `LETTER_IRL_OAUTH_AUDIENCE` (Auth0 API identifier, e.g., `https://letter-irl/api`)
   - `LETTER_IRL_OAUTH_CLIENT_ID` (Mail Letter IRL application)
   - ChatGPT has no Letter IRL-held client secret; the static registration
     settings exist only for the explicitly enabled rollback mode.

## 4. Validate Tokens on Every Tool Call
1. Use `jose` (already in the repo) with Auth0’s JWKS to verify ID tokens.
2. Extend `ToolContext` with an `auth` object containing `userId`, `email`, and scopes pulled from the JWT.
3. When requests arrive:
   - If no `Authorization: Bearer` header is present, respond with an auth challenge per Apps SDK spec.
   - Otherwise validate the token (issuer, audience/client ID, expiration) and attach the user claims to the context.
4. Map `userId = token.sub` when reading/writing Firestore documents, so each ChatGPT user has dedicated credits/orders.

## 5. Firestore Schema & Access Rules
1. Collections:
   - `users/{userId}` — `creditsRemaining`, profile info, billing metadata.
   - `jobs/{jobId}` — letter snapshot, status timeline, `userId`, credit cost.
2. Create Firestore security rules that allow reads/writes only when `request.auth.uid == resource.data.userId` (except for admin service accounts).
3. Update `src/store` to use Firestore instead of the JSON file: implement repositories for users and jobs, keeping the same interfaces so the rest of the code stays untouched.

## 6. Admin & Worker Flows
1. Create a Cloud Function (or Cloud Run job) that listens for `jobs` with `status="queued_for_print"`, calls the print vendor, and updates the timeline.
2. Build a small admin API that uses a service account to:
   - List jobs
   - Adjust credits
   - Re-run failed jobs
3. Later, expose new MCP tools (or a separate admin dashboard) that surfaces Firestore data in real time.

## 7. Testing & Rollout
1. Use MCP Inspector to test an OAuth-protected tool call (provide the bearer token manually).
2. In ChatGPT Dev Mode, switch the connector auth type to OAuth and enter the Identity Platform endpoints + scopes.
3. Verify the PKCE flow works end-to-end (ChatGPT prompts for Google sign-in, Letter IRL receives valid ID tokens, Firestore stores user-specific data).
4. Once identity is stable, remove the dev `LETTER_IRL_DEFAULT_USER_ID` fallback and rely purely on OAuth claims.

Implementing these steps moves Letter IRL from a single hard-coded user to secure, per-user storage with Firestore-backed credits and a job queue ready for real mail fulfillment.
