# ChatGPT OAuth migration: Auth0 public CIMD with PKCE

Status: implementation-ready  
Tracking issue: https://github.com/dnobj/mail-letter-irl/issues/160  
Target branches: dev first; master only after acceptance  
Last reviewed: 2026-07-23

## Objective

Replace Letter IRL's static Dynamic Client Registration compatibility shim and misleading OAuth metadata with the current OpenAI-recommended Client ID Metadata Document (CIMD) design, using Auth0 features that do not require the Enterprise tier.

The selected design is:

- Auth0 manual CIMD application registration.
- OAuth 2.0 authorization code flow.
- PKCE using S256.
- A public client with token_endpoint_auth_method set to none.
- The ChatGPT-provided CIMD URL as the OAuth client ID.
- Exact ChatGPT callback URLs registered through the imported CIMD document.
- Separate development and production Auth0 applications and configuration.
- No dependency on Auth0 Enterprise or private_key_jwt.

Auth0 private_key_jwt remains an optional future hardening path if the commercial tier and threat model ever justify it. It is not required for this migration.

## Why this change

The current production-compatible workaround prevents uncontrolled Auth0 client creation by returning one static client from /oauth/register. It was useful when ChatGPT depended on DCR, but it now has several weaknesses:

- Letter IRL advertises CIMD support without using a client metadata URL as the client ID.
- The registration route ignores the submitted registration document.
- One Auth0 client mixes ChatGPT, review, and Claude callback URLs.
- Repository documentation still alternates between DCR, static registration, and CIMD.
- New ChatGPT app callback IDs can fail until manually added to the shared client.
- The proxy metadata can disagree with Auth0's actual authorization-server metadata.
- Token scope, audience, and resource conventions are not documented or enforced consistently.

OpenAI currently recommends CIMD for production MCP apps and still supports a public-client method using PKCE with no secret. Auth0 supports manual CIMD registration for this public-client form without Enterprise. Auth0 Enterprise is required only for the private_key_jwt variant.

## Scope

### In scope

- Correct authorization-server and protected-resource metadata.
- A manual Auth0 CIMD application for the DEV ChatGPT app, followed by production after acceptance.
- Public-client PKCE behavior with no client secret.
- Exact callback and client metadata registration.
- Removal of the static DCR workaround after a controlled compatibility window.
- Explicit issuer, audience/resource, algorithm, expiry, and scope validation.
- Separation of the ChatGPT OAuth client from Claude Desktop or other MCP clients.
- Startup validation for OAuth-critical configuration.
- Automated and manual test coverage.
- Documentation and environment-example cleanup.
- Development-first rollout, rollback, and production-promotion gates.

### Out of scope

- Auth0 Enterprise and private_key_jwt.
- A generic shared OAuth client for every MCP host.
- Product UX work, payment flows, or unrelated launch-readiness items.
- Replacing Auth0.
- Database schema changes.
- Production rollout before DEV acceptance and owner approval.

## Architecture decision

### ChatGPT client

ChatGPT is a public OAuth client identified by its HTTPS CIMD URL. The imported document must specify the allowed redirect URIs, authorization_code grant, code response type, PKCE-compatible public-client behavior, and token_endpoint_auth_method of none. Auth0 stores the imported document as a strict third-party application.

Letter IRL must not hold a ChatGPT client secret. PKCE protects authorization-code redemption. Redirect URIs are taken from the ChatGPT CIMD document and must exactly match the app's current callback ID.

### Authorization server

The OAuth issuer and discovery documents must come from the actual Auth0 tenant. Letter IRL must not publish an authorization-server proxy that claims capabilities Auth0 does not expose. The MCP protected-resource metadata should name the canonical resource and point clients to the Auth0 issuer.

Auth0's Client ID Metadata Document Registration feature must be enabled separately in the development and production tenants. The Resource Parameter Compatibility Profile should be enabled when required by Auth0's CIMD flow and validated in DEV before production.

### Resource and audience

Implementation must make one canonical resource/audience decision instead of silently mixing the API origin with the existing Auth0 audience.

Current configurations may use https://letter-irl/api while the protected resource is served from https://api.letterirl.com. Before changing either value, record the live DEV and production values and their consumers.

Selected end state:

- protected resource: the exact canonical MCP endpoint, including /mcp;
- production resource: https://api.letterirl.com/mcp;
- development resource: the exact public DEV MCP endpoint, also including /mcp;
- MCP token audience: a dedicated Auth0 API identifier equal to that environment's canonical MCP resource;
- website and REST tokens: retain their existing audience and authentication path;
- validation: exact issuer and audience allowlists per environment;
- no acceptance of arbitrary audiences.

Create a dedicated MCP API identifier rather than changing the existing website/REST audience in place. If a compatibility phase is needed, implement and test it only in DEV first. Never change the production audience implicitly.

### Scopes

OIDC identity scopes such as openid, profile, and email are not sufficient authorization for mail actions. Define and enforce minimal product scopes, with a documented tool-to-scope mapping. Use this initial scope model unless implementation discovers a concrete incompatibility:

- mail:read for balance, order, status, and saved-return-address reads;
- mail:draft for previews, generated images, and draft or address writes;
- mail:send for physical send operations.

Keep openid, profile, and email for identity. Add offline_access only if refresh-token behavior is deliberately enabled and tested.

Sensitive tools must fail closed when the required scope is absent. The WWW-Authenticate challenge, protected-resource metadata, Auth0 API permissions, and server-side checks must agree.

### Other clients

Claude Desktop and other MCP hosts must not share ChatGPT's CIMD application merely to reuse redirect URIs. Preserve their working authentication through a separate client or adapter, such as the existing personal-access-token path, until a client-specific OAuth design is planned and tested.

## Implementation phases

### Phase 0 — Inventory and recovery baseline

Before changing code or tenant settings:

1. Capture the current DEV and production Auth0 issuer, audience/API identifier, application IDs, allowed callbacks, allowed origins, grants, connections, API access policy, DCR setting, CIMD setting, and resource-parameter profile.
2. Record the current ChatGPT DEV and production app IDs, CIMD URLs, and exact callback URLs.
3. Confirm which client IDs have recently issued tokens and whether Claude or any review client depends on the shared static application.
4. Export or screenshot the relevant Auth0 settings so each environment can be restored.
5. Confirm production remains untouched during DEV implementation.
6. Add no credentials, client IDs that are treated as secret, tenant exports, or user data to the repository.

Deliverable: a non-secret environment matrix appended to the implementation PR description or the owner-only rollout record.

### Phase 1 — Make server metadata truthful

Update the OAuth metadata implementation so that:

1. /.well-known/oauth-protected-resource points to the configured Auth0 issuer and publishes the canonical resource and supported scopes.
2. The 401 WWW-Authenticate challenge references the same protected-resource document and scopes.
3. Authorization-server discovery is obtained from Auth0, not synthesized with unsupported flags.
4. Letter IRL does not advertise client_id_metadata_document_supported unless that claim comes from the configured Auth0 tenant.
5. The static /oauth/register route and registration_endpoint advertisement are placed behind a narrowly named temporary compatibility flag, disabled by default in DEV after CIMD acceptance.
6. CHATGPT_STATIC_CLIENT_ID is deprecated and removed after the compatibility window.
7. Environment configuration cannot accidentally point DEV at the production Auth0 tenant or production at DEV.
8. OAuth-critical values are validated at startup: issuer, JWKS URL, authorization endpoint, token endpoint, canonical base URL/resource, audience, allowed algorithms, and required scopes.

Do not remove the rollback path until the new DEV connection has passed fresh-account testing.

### Phase 2 — Harden token validation and identity handling

Use one production token-validation path and test that exact implementation.

Required behavior:

- Pin Auth0's expected signing algorithm; reject none and unexpected algorithms.
- Validate issuer, audience, expiry, not-before when present, and required scopes.
- Reject missing or malformed subject claims.
- Avoid fetching userinfo with personal-access tokens or other non-Auth0 credentials.
- Do not overwrite a known user identity with a placeholder such as unknown@example.com when a userinfo lookup is unavailable.
- Return standards-aligned OAuth errors without including tokens or personal data in logs.
- Keep authorization decisions server-side; widget state is not authoritative.

Add structured, non-sensitive diagnostics for issuer/audience/scope failures so live OAuth problems can be distinguished without logging bearer tokens or request bodies.

### Phase 3 — Configure the DEV Auth0 CIMD application

This phase is owner-gated because it changes Auth0 and ChatGPT configuration.

1. In the DEV ChatGPT app, copy the current CIMD URL and exact callback URL.
2. In the development Auth0 tenant, enable Client ID Metadata Document Registration.
3. Enable the Resource Parameter Compatibility Profile if required for the selected Auth0 configuration.
4. Import the ChatGPT CIMD URL through Auth0's manual CIMD registration flow.
5. Confirm the resulting application is a public strict third-party application with token_endpoint_auth_method set to none and PKCE required.
6. Create or select the dedicated DEV MCP API whose identifier exactly equals the DEV /mcp resource, then grant only mail:read, mail:draft, and mail:send to the imported application.
7. Configure the identity connections Auth0 requires for a strict third-party app. Audit domain-level connections rather than disabling them blindly, because Auth0 CIMD relies on eligible domain-level connections.
8. Verify the actual Auth0 discovery response advertises CIMD support.
9. Confirm the client ID used by ChatGPT is the CIMD URL, not an opaque static Auth0 client ID.
10. Leave production unchanged.

Record exact non-secret settings and evidence in the PR or manual-test result. If the CIMD import changes callback metadata, fix the source ChatGPT document or registration instead of adding wildcard callbacks.

### Phase 4 — Automated tests

Add or update tests under tests/unit and, where appropriate, tests/integration.

Required coverage:

- Protected-resource metadata uses the configured issuer, resource, and scopes.
- Authorization metadata does not invent a CIMD capability or registration endpoint.
- Unauthorized MCP initialization returns the correct WWW-Authenticate challenge.
- Token validation accepts a valid Auth0 RS256 token for the configured issuer, audience, and scopes.
- Token validation rejects wrong issuer, wrong audience, expired token, not-yet-valid token, missing scope, malformed subject, none, and unexpected algorithms.
- Scope enforcement includes a happy path and failure path for mail:read, mail:draft, and mail:send, with tool metadata matching runtime enforcement.
- The identity fallback cannot replace a known email with a placeholder.
- Personal-access-token handling does not call Auth0 userinfo.
- Startup validation rejects cross-environment issuers, missing endpoints, missing resource/audience, and unsafe production values.
- Strict startup validation is activated by
  `LETTER_IRL_OAUTH_CIMD_ENFORCEMENT=true` only in the coordinated environment
  cutover, so merging to the auto-deployed DEV branch cannot accidentally apply
  a half-configured migration.
- The legacy registration shim is unavailable when its temporary compatibility flag is off.
- A live-contract check or release script compares expected DEV discovery fields with the actual Auth0 documents without storing credentials.

Run npm run lint for source-relevant changes, npx tsc --noEmit while recording known baseline failures separately, and npm run test:run. Do not hide pre-existing failures; distinguish them from regressions.

### Phase 5 — DEV manual acceptance

The live browser-test task must add versioned manual test cases before executing them. At minimum test:

1. Unlink the DEV Letter IRL app and revoke any stale grant.
2. Connect with a fresh or clean test account.
3. Confirm consent displays the expected Letter IRL identity and least-privilege scopes.
4. Complete OAuth and verify no DCR request creates a new Auth0 application.
5. Run get_started and confirm DEV tools are exposed.
6. Generate an image and confirm the Letter IRL widget renders; no unintended native-image fallback is used.
7. Create or edit a postcard preview.
8. Exercise a controlled authorization failure for a missing sensitive scope.
9. Disconnect, reconnect, and re-consent.
10. Switch accounts and confirm identity is not mixed.
11. Revoke the Auth0 grant and confirm the next action requires authentication.
12. Repeat the core link-and-tool flow on ChatGPT web and the supported mobile clients.
13. Repeat connection more than once and confirm Auth0 client count does not increase.
14. Verify logs contain no access tokens, authorization codes, letter content, addresses, or raw request bodies.
15. Test the temporary rollback flag in DEV and restore the CIMD path afterward.

Attach screenshots or concise logs to the implementation PR, redacting tokens and personal information.

### Phase 6 — Retire DEV DCR compatibility

After DEV acceptance:

1. Disable Auth0 DCR in the development tenant if inventory confirms no other client depends on it.
2. Disable the Letter IRL static registration compatibility flag.
3. Remove the DEV static client setting.
4. Re-run the full OAuth and image-generation manual suite.
5. Observe DEV for an agreed soak period and confirm no new Auth0 clients, authorization errors, or scope failures.

The implementation PR may remove the shim outright only if the inventory and rollback test prove it is unused. Otherwise, removal follows as a small cleanup issue with a fixed deadline and owner.

### Phase 7 — Documentation

Update all sources that still describe DCR as mandatory or the static-client shim as the target architecture, including:

- README.md
- SETUP.md
- .env.example and .env.dev.example
- docs/oauth-plan.md
- docs/apps-sdk-guidelines.md
- docs/chatgpt-app-submission.md
- docs/auth0-setup.md
- docs/auth0-tenant-configuration.md
- docs/deployment.md
- docs/infrastructure.md
- docs/manual-tests.md
- docs/learnings/dcr-static-client-workaround.md
- the app-submission owner and test checklists

Documentation must clearly distinguish:

- current target architecture;
- temporary compatibility behavior;
- owner-only Auth0 and OpenAI steps;
- development and production values;
- ChatGPT CIMD from Claude or PAT authentication;
- public-client PKCE from the optional Enterprise-only private-key method.

### Phase 8 — Production promotion

Production is a separate, owner-approved operation after the implementation PR is merged to dev, automated tests pass, DEV manual acceptance is recorded, and the soak period is clean.

1. Reconfirm the production ChatGPT CIMD and callback URLs.
2. Repeat the Auth0 backup and inventory for production.
3. Import the production CIMD into the production Auth0 tenant.
4. Apply the approved API access, scopes, connection policy, and resource compatibility settings.
5. Deploy the already accepted code through the normal dev-to-master promotion.
6. Test a controlled production account: fresh link, consent, get_started, image generation, preview, reconnect, revoke, and controlled send only when explicitly authorized.
7. Monitor authorization failures, client count, error rate, and sensitive logging.
8. Disable production DCR and the static shim only after successful observation and dependency confirmation.
9. Record the final production configuration and rollback owner.

Do not combine this promotion with unrelated deployment or database changes.

## Rollback

Rollback is per environment.

If DEV or production linking fails:

1. Stop promotion and preserve diagnostic evidence without tokens.
2. Re-enable the temporary static-registration compatibility flag only in the affected environment.
   Set `CHATGPT_STATIC_REDIRECT_URIS` to the exact callback inventory already
   configured on the rollback Auth0 client. In compatibility mode, protected
   resource discovery points to Letter IRL's authorization-server proxy, which
   advertises `/oauth/register`; the static registration response returns only
   that explicit inventory.
3. Restore the previously recorded Auth0 application, API access, connection, and discovery settings.
4. Re-enable DCR only if the prior working state required it and the security impact is understood.
5. Restore the previous deployment version if server metadata or validation caused the failure.
6. Re-run a fresh-link smoke test.
7. Open a focused follow-up issue before attempting promotion again.

No database rollback is expected. Production must not be rolled back by pointing it to development OAuth resources.

## Acceptance criteria

The issue is complete only when:

- Auth0's real discovery metadata for the active environment supports the chosen CIMD flow.
- ChatGPT identifies itself with the current CIMD URL and uses its exact callback URL.
- Authorization code plus PKCE S256 succeeds without a client secret.
- Repeated installs and reconnects do not create new Auth0 clients.
- Letter IRL no longer publishes misleading authorization-server capabilities.
- Issuer, audience, expiry, algorithm, subject, and required scopes are enforced by production code.
- ChatGPT and Claude/PAT authentication are separated.
- DEV automated tests and the full DEV manual OAuth/widget suite pass.
- Production remains unchanged until the documented approval gate.
- DCR and static-client settings are removed from each environment only after dependency checks.
- Documentation no longer says DCR is mandatory and accurately describes public CIMD without implying Auth0 Enterprise is required.
- A tested, environment-specific rollback procedure is recorded.
- The implementation PR links issue #160 and this plan and includes test evidence.

## Follow-up opportunities

Track separately rather than expanding this issue:

- Evaluate private_key_jwt only if Auth0 Enterprise becomes acceptable.
- Add automated synthetic OAuth monitoring with a dedicated non-production principal.
- Standardize OAuth adapter requirements for additional MCP hosts.
- Review the entire production-readiness backlog, including retention, request logging, health checks, and security headers.


## Primary references

- OpenAI Apps SDK authentication: https://developers.openai.com/apps-sdk/build/auth/
- OpenAI authenticated MCP server scaffold for Auth0: https://github.com/openai/openai-mcpkit/tree/main/python-authenticated-mcp-server-scaffold
- Auth0 manual CIMD registration: https://auth0.com/docs/get-started/auth0-overview/create-applications/register-applications-with-cimd
