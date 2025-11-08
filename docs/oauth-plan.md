# OAuth & Identity Plan (Google Cloud + Firestore)

This plan outlines how to add per-user identity and credit tracking using Google Cloud’s OAuth stack. The goal is to let ChatGPT authenticate each end user, so Letter IRL can map tool calls to individual Firestore accounts.

## 1. Google Cloud Setup
1. Create (or reuse) a Google Cloud project.
2. Enable **Firestore** (Native mode) for persistent storage of user accounts, credit balances, and letter jobs.
3. Enable **Identity Platform** (Firebase Auth) to act as the OAuth 2.1 / OIDC provider.
4. Create a service account with Firestore access for backend workers (job queue, admin tools).

## 2. Configure Identity Platform OAuth
1. In Identity Platform, configure the sign-in methods you want (email/password, Google Sign-In, etc.).
2. Set up an OAuth consent screen (External) and publish it after verification.
3. Under **Authorized domains**, add the ChatGPT callback domain (`chat.openai.com`) and your ngrok/custom domain hosting the MCP server.
4. Create an OAuth client of type “Web application.” Collect:
   - Authorization endpoint (e.g., `https://<project-id>.firebaseapp.com/__/auth/handler`)
   - Token endpoint (Identity Platform exposes this via Google’s OAuth token service)
   - JWKS URI (Google’s certs endpoint), issuer, and supported scopes (at least `openid email profile`).

## 3. Expose MCP Auth Metadata
ChatGPT expects your MCP server to host:
- `/.well-known/oauth-authorization-server` (or `openid-configuration`) describing the authorization and token endpoints.
- `/.well-known/oauth-protected-resource` describing resource server metadata.

Action items:
1. Add a new `src/auth/metadata.ts` helper that serves those JSON docs, pointing to the Identity Platform endpoints.
2. Update `src/mcp/httpServer.ts` to route requests for the `.well-known` paths to that helper.
3. Document environment variables: `LETTER_IRL_OAUTH_ISSUER`, `LETTER_IRL_OAUTH_AUTH_ENDPOINT`, `LETTER_IRL_OAUTH_TOKEN_ENDPOINT`, `LETTER_IRL_OAUTH_JWKS_URI`, `LETTER_IRL_OAUTH_CLIENT_ID`, etc.

## 4. Validate Tokens on Every Tool Call
1. Install Google’s JWKS client (e.g., `jwks-rsa`) or use `google-auth-library` to verify ID tokens.
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
