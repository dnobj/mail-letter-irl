# Auth0 Tenant Configuration

**Last Updated:** September 14, 2026

This document provides a complete reference of the Auth0 tenant configuration used for the ChatGPT MCP Server with OAuth authentication.

## Current configuration contract

Development and production each use a dedicated Auth0 MCP API whose identifier
is the exact canonical environment `/mcp` URL. ChatGPT is a manually imported,
strict third-party CIMD application using authorization code + PKCE S256 and
`private_key_jwt` client authentication. Grant only `mail:read`, `mail:draft`,
and `mail:send`.

The website uses the same MCP API. Its application (`Letter IRL Website`) is
authorized for the MCP API with the same three scopes and requests them at
login. Every REST route the dashboard calls requires the scope its MCP tool
twin requires (`src/auth/restScopes.ts`). Both environments were switched on
2026-09-14 (recorded in 2d and 2e below). Personal access tokens remain a
separate path. The old website/REST API, `https://letter-irl/api`, is retired:
the API server accepts exactly one audience, the MCP resource. Each tenant's
Default Audience now names its MCP API, and the old API was deleted from both
tenants on 2026-09-14.

**Corrected 2026-09-05, on first contact with a real import.** This document
previously specified a *public* client with `token_endpoint_auth_method: none`,
and stated that `private_key_jwt` was not part of the design. Auth0 cannot
produce that shape from ChatGPT's document, and the prescription was
unachievable rather than merely unmet:

- A CIMD document declares **one** `token_endpoint_auth_method`, and Auth0 takes
  it as given - it does not choose among the client's alternatives. ChatGPT
  declares `private_key_jwt`; its `token_endpoint_auth_methods_supported`
  (which does list `none`) is explicitly ignored, and the import dialog says so.
- The method is not in Auth0's post-import editable set (`description`,
  `jwt_configuration.alg`, `allowed_origins`, `client_metadata`), and
  CIMD-derived properties re-sync from the hosted document, so an override would
  be reverted rather than held.
- It is the stronger posture regardless: a signed assertion against ChatGPT's
  two pinned RS256 keys, versus an unauthenticated public client. Our server
  validates the resulting access token and takes no part in client
  authentication, so nothing in `src/` depends on which is used.
- OpenAI's Apps SDK sanctions both ("use `none` for public-client token exchange
  or `private_key_jwt` when your authorization server requires client
  authentication"), and the tenant advertises both.

The DCR/static-client sections below document the temporary rollback baseline,
not the desired configuration. Do not enable them in a normal CIMD rollout.

## Tenants Overview

| Environment | Tenant Domain | Account |
|-------------|---------------|---------|
| **Development** | `dev-ky21dxn3qmi71hjl.us.auth0.com` | dnicholl@objective.works |
| **Production** | `dev-njmdyqf8n25rqgy7.us.auth0.com` | dnicholl@letterirl.com |

---

## Table of Contents

- [Quick Reference: Application Configuration Matrix](#quick-reference-application-configuration-matrix)
- [Overview](#overview)
- [Tenant Information](#tenant-information)
- [Connections (Identity Providers)](#connections-identity-providers)
- [Applications](#applications)
- [APIs / Resource Servers](#apis--resource-servers)
- [Key Settings for ChatGPT MCP](#key-settings-for-chatgpt-mcp)
- [Management via CLI](#management-via-cli)
- [Common Operations](#common-operations)
- [Environment Configuration](#environment-configuration)

---

## Quick Reference: Application Configuration Matrix

Use this table to verify each application has the correct settings:

| Application | Type | Callbacks Required | Web Origins Required | Domain Connection |
|-------------|------|-------------------|---------------------|-------------------|
| **Mail Letter IRL** | SPA | `https://chat.openai.com/aip/auth/callback`<br>`https://chatgpt.com/connector_platform_oauth_redirect`<br>`https://platform.openai.com/apps-manage/oauth` | `https://chat.openai.com`<br>`https://chatgpt.com`<br>`https://platform.openai.com` | N/A |
| **Letter IRL API** | M2M | None | None | N/A |
| **ChatGPT CIMD** | Strict third-party, `private_key_jwt` (Auth0 maps `app_type: regular_web`; strict is forced, not chosen) | Exact current `https://chatgpt.com/connector/oauth/{callback_id}` from CIMD | N/A | Domain-level connections |

### Tenant-Level Settings Checklist

| Setting | Location | Required Value |
|---------|----------|----------------|
| CIMD registration | Settings → Advanced | Enabled for the target environment |
| MCP API identifier | Applications → APIs | Exact canonical environment `/mcp` URL |
| DCR Enabled | Settings → Advanced | Rollback inventory only |
| Friendly Name | Settings → General | `Letter IRL` |
| Google Connection | Connections | `is_domain_connection: true` |
| Microsoft Connection | Connections | `is_domain_connection: true` |
| Apple Connection | Connections | `is_domain_connection: true` |
| GitHub Connection | Connections | `is_domain_connection: true` |
| Username-Password | Connections | `is_domain_connection: true` |

### Branding Checklist

| Setting | Value | Status (Dev) | Status (Prod) |
|---------|-------|--------------|---------------|
| Friendly Name | `Letter IRL` | ✅ Applied | ✅ Applied |
| Logo URL | `https://letterirl.com/logo.jpg` | ✅ Applied | ✅ Applied |
| Favicon URL | `https://letterirl.com/favicon.ico` | ✅ Applied | ❓ Unverified |
| Primary Color | `#1a8ccc` | ✅ Applied | ❓ Unverified |
| Page Background | `#ffffff` | ✅ Applied | ❓ Unverified |
| ChatGPT MCP App Name | `Letter IRL` | ✅ Applied | ❓ Unverified |
| ChatGPT MCP App Logo | `https://letterirl.com/logo.jpg` | ✅ Applied | ❓ Unverified |

Production rows corrected 2026-08-24: friendly name and logo were audited
directly and are applied, having been listed as Pending since July. The
remaining rows were not inspected and are marked unverified rather than assumed
either way - a checklist that guesses is worse than one that admits a gap.

---

## Overview

This Auth0 tenant is configured to support:
- **ChatGPT MCP Server** with OAuth 2.1 + PKCE authentication
- **Manual CIMD registration** for ChatGPT apps
- **5 Authentication Methods**: Google, Microsoft, Apple, GitHub, Email/Password
- **Audited eligible connections** for strict third-party CIMD clients

---

## Tenant Information

| Property | Value |
|----------|-------|
| **Domain** | `dev-ky21dxn3qmi71hjl.us.auth0.com` |
| **Region** | US (dev) |
| **Default Audience** | `https://letter-irl-api-development.up.railway.app/mcp` (the MCP API; repointed from the retired `https://letter-irl/api` on 2026-09-14) |
| **OIDC DCR Enabled** | Rollback inventory only; not required by ChatGPT CIMD |

### Important Endpoints

```bash
# OAuth Authorization Server Discovery
https://dev-ky21dxn3qmi71hjl.us.auth0.com/.well-known/oauth-authorization-server

# JWKS (JSON Web Key Set)
https://dev-ky21dxn3qmi71hjl.us.auth0.com/.well-known/jwks.json

# Authorization Endpoint
https://dev-ky21dxn3qmi71hjl.us.auth0.com/authorize

# Token Endpoint
https://dev-ky21dxn3qmi71hjl.us.auth0.com/oauth/token

# Dynamic Client Registration (RFC 7591)
https://dev-ky21dxn3qmi71hjl.us.auth0.com/oidc/register
```

---

## Connections (Identity Providers)

All connections are configured as **domain-level connections** (`is_domain_connection: true`) to support ChatGPT's dynamically registered OAuth clients.

### 1. Google (google-oauth2)

```json
{
  "id": "con_0TaXOw40EOEjAtWF",
  "name": "google-oauth2",
  "strategy": "google-oauth2",
  "is_domain_connection": true,
  "options": {
    "email": true,
    "profile": true,
    "scope": ["email", "profile"]
  }
}
```

**Provider Type:** Social (OAuth 2.0)
**Scopes:** `email`, `profile`

### 2. Microsoft (windowslive)

```json
{
  "id": "con_yXECqXNAc3kuLPYs",
  "name": "Microsoft",
  "strategy": "windowslive",
  "is_domain_connection": true,
  "options": {
    "signin": true,
    "scope": ["wl.signin"]
  }
}
```

**Provider Type:** Social (Microsoft Personal Accounts)
**Scopes:** `wl.signin`

> **Note:** This connection supports Microsoft **personal accounts** only. For work/organizational accounts, use an Enterprise connection with Azure AD.

### 3. Apple

```json
{
  "id": "con_FxgZyyw39YHjWKiM",
  "name": "Apple",
  "strategy": "apple",
  "is_domain_connection": true,
  "options": {}
}
```

**Provider Type:** Social (Sign in with Apple)

### 4. GitHub

```json
{
  "id": "con_GDXmYmXKIYPTt0TD",
  "name": "GitHub",
  "strategy": "github",
  "is_domain_connection": true,
  "options": {
    "scope": []
  }
}
```

**Provider Type:** Social (OAuth 2.0)

### 5. Username-Password-Authentication

```json
{
  "id": "con_KsLx9jreL6UbX7ZB",
  "name": "Username-Password-Authentication",
  "strategy": "auth0",
  "is_domain_connection": true,
  "options": {
    "passwordPolicy": "good",
    "brute_force_protection": true,
    "mfa": {
      "active": true,
      "return_enroll_settings": true
    },
    "authentication_methods": {
      "password": {
        "enabled": true
      },
      "passkey": {
        "enabled": false
      }
    },
    "passkey_options": {
      "challenge_ui": "both",
      "local_enrollment_enabled": true,
      "progressive_enrollment_enabled": true
    },
    "strategy_version": 2
  }
}
```

**Provider Type:** Database (Auth0 Database)
**Password Policy:** Good
**Brute Force Protection:** ✅ Enabled
**MFA:** ✅ Available
**Passkeys:** ❌ Currently disabled

---

## Applications

### 1. Default App

| Property | Value |
|----------|-------|
| **Client ID** | `dh1gQFsJJJBqMUhCQ8hlA1XoFSGhQ6or` |
| **Type** | Generic |
| **Grant Types** | `authorization_code`, `implicit`, `refresh_token`, `client_credentials` |

Default application created by Auth0.

### 2. Mail Letter IRL

| Property | Value |
|----------|-------|
| **Client ID** | `fH2bdMWvE7ql8AElZSqXk1c2p3lXjOhx` |
| **Type** | Single Page Application (SPA) |
| **Grant Types** | `authorization_code`, `implicit`, `refresh_token` |
| **Callbacks** | `https://chat.openai.com/aip/auth/callback`<br>`https://chatgpt.com/connector_platform_oauth_redirect`<br>`https://platform.openai.com/apps-manage/oauth` |
| **Logout URLs** | `https://chat.openai.com/aip/auth/callback`<br>`https://chatgpt.com/connector_platform_oauth_redirect` |
| **Web Origins** | `https://chat.openai.com`<br>`https://chatgpt.com`<br>`https://platform.openai.com` |

Main application for the Letter IRL project.

> **Important:** The `https://platform.openai.com/apps-manage/oauth` callback is required for the OpenAI app review process. See [OpenAI Apps SDK Auth Documentation](https://developers.openai.com/apps-sdk/build/auth/).

### 3. Letter IRL API (Test Application) - deleted

| Property | Value |
|----------|-------|
| **Client ID** | `PAKBkBq83uRlSJxiyWGYhN9FalzxOBFJ` |
| **Type** | Machine to Machine |
| **Grant Types** | `client_credentials` |

Auth0 created it alongside the retired `Letter IRL API`. It held no grant on
any API, and it was deleted on 2026-09-14, after that API.

### 4. API Explorer Application

| Property | Value |
|----------|-------|
| **Client ID** | `r3lHNjD1zAFNLRgIh0ljtEtuDyerCxO8` |
| **Type** | Machine to Machine |
| **Grant Types** | `client_credentials` |

Auth0's API Explorer for Management API access. Nothing in this repository uses
it, and it is most likely the development credential the removed prod-to-dev
sync authenticated as (`AUTH0_DEV_CLIENT_ID`). Its Management API client access
was revoked on 2026-09-14. Delete it once the tenant logs show no failed token
exchange from its client id; authorizing its client access again undoes the
revoke.

### 5. ChatGPT (Dynamically Registered)

| Property | Value |
|----------|-------|
| **Client ID** | `SGDLjJ3LJC525aAr9ZUebnJhFGkDZcAI` (example) |
| **Type** | Generic |
| **Grant Types** | `authorization_code`, `refresh_token` |
| **Callbacks** | `https://chatgpt.com/connector_platform_oauth_redirect` |

Dynamically registered via RFC 7591 when ChatGPT connects to the MCP server. Multiple instances may exist as users connect/reconnect.

---

## APIs / Resource Servers

### 1. Auth0 Management API

| Property | Value |
|----------|-------|
| **Identifier** | `https://dev-ky21dxn3qmi71hjl.us.auth0.com/api/v2/` |
| **Name** | Auth0 Management API |

Auth0's Management API with 200+ scopes for programmatic tenant administration.

### 2. Deleted website/REST API

| Property | Value |
|----------|-------|
| **Identifier** | `https://letter-irl/api` |
| **Name** | Letter IRL API |
| **Scopes** | None configured |

**Retired, then deleted from both tenants on 2026-09-14.** The website and the
REST routes moved onto the MCP API in both environments (website PRs #22 and
#26, API PRs #386 and #388). The server no longer accepts this audience in any
mode:
- `LETTER_IRL_OAUTH_LEGACY_AUDIENCES` is gone.
- The static-DCR flag no longer widens the accepted audience.
- Token validation refuses to run with more than one configured audience.

Each tenant's Default Audience was repointed to its MCP API identifier before the
API was deleted. Do not recreate it: the dedicated MCP API, whose identifier
exactly equals the environment's canonical `/mcp` resource, is the only API
Letter IRL uses.

---

## Key Settings for ChatGPT MCP

### Required Post Login Action: the email claim

**Without this, no account is ever created.** `prepareAuthenticatedUser`
provisions the `users` row from a verified email, and Auth0 does not put
`email` on an access token minted for a custom API. Every write then fails on
`REFERENCES users(user_id)` in whichever table the customer reaches first.

Add a Post Login Action containing:

```javascript
exports.onExecutePostLogin = async (event, api) => {
  if (!event.user.email || event.user.email_verified !== true) return;
  api.accessToken.setCustomClaim("https://letterirl.com/email", event.user.email);
  api.accessToken.setCustomClaim("https://letterirl.com/email_verified", true);
};
```

**Only a confirmed address, and always both claims.** The address is what a
Letter IRL account is, and what the linking Action below joins identities on,
so an unconfirmed one must not reach either.

The server opens an account only when the verdict claim is exactly `true` (the
boolean, or the string). An address claim with `false` beside it is refused
outright. An address claim with **no** verdict beside it opens nothing on its
own: the server asks `/userinfo`, but only for a token carrying `openid`. See
`src/auth/verifiedEmail.ts`, which has the reasoning.

**Update this Action BEFORE deploying the API against the tenant**, and take
the order seriously, because the fallback covers less than it looks like it
does. Auth0's `/userinfo` requires `openid` on the access token; ChatGPT asks
for the per-tool scopes plus `offline_access` and no identity scope, so a
ChatGPT token can never be answered there. In the window between the API
deploying and this Action being updated:

| Who | What happens |
| --- | --- |
| Anyone with an account already | Unaffected. An existing account is never refused, whatever the token says. |
| A new customer on the website | Their token carries `openid`, so `/userinfo` answers and the account opens. Website tokens live 2 hours. |
| A new customer in ChatGPT | Refused, with the sentence, until they reconnect. Their token lives 24 hours. |

The refusal says which case it is: `auth.account_missing_no_verified_email`
carries `userInfo: "not_asked_no_openid"` for exactly this state, as against
`email_unconfirmed` for an address the issuer says is not confirmed.

So: set both claims, or set neither. Setting the address alone leaves every new
ChatGPT customer refused until the verdict claim appears.

**The namespace is load-bearing.** Auth0 silently drops a non-namespaced custom
claim that collides with a reserved OIDC name, and `email` is reserved - the
login succeeds, the claim is absent, and nothing reports it. An Action calling
`setCustomClaim("email", ...)` is a no-op that looks exactly like a fix; one
was deployed against production on 2026-09-05 and the next tool call failed the
same foreign key it had failed before. See
[Auth0's custom-claims guidance](https://auth0.com/docs/troubleshoot/product-lifecycle/deprecations-and-migrations/custom-claims-migration).

Deploying the Action is not enough on its own - it must also be dragged into
the **Post Login trigger flow** and applied, or it never runs.

The server reads `LETTER_IRL_OAUTH_EMAIL_CLAIM` (default
`https://letterirl.com/email`) and
`LETTER_IRL_OAUTH_EMAIL_VERIFIED_CLAIM` (default
`https://letterirl.com/email_verified`), so the two environments can namespace
against their own domains. It prefers a standard `email` claim when one is
present, and still falls back to `/userinfo`.

### Required Post Login Action: linking one person's sign-in methods

**Auth0 mints a subject per sign-in method.** Without this Action, one person
signing in with Google and with a password is two subjects presenting one
address - and `users.email` is `NOT NULL UNIQUE`, so the second one collides,
is refused, and that person has no account. This Action makes the address the
identity by joining the identities behind it.

Put it **above** the email-claim Action in the Post Login trigger flow. Not
because the claim's value depends on it - both identities carry the same
address by construction, since the Action looks up by `event.user.email` - but
because a login this Action denies should be denied before anything else runs.

The ordering that IS load-bearing is inside the Action: the Management API
link must happen **before** `setPrimaryUser`, which requires the identity that
authenticated this login to already be a secondary of the primary user. The
code below does them in that order.

```javascript
const { ManagementClient } = require("auth0");

exports.onExecutePostLogin = async (event, api) => {
  // An address nobody has proved they own is not an identity. A password
  // sign-up that has not confirmed its address is refused here, at the source,
  // rather than being allowed to claim someone else's account.
  if (!event.user.email || event.user.email_verified !== true) {
    api.access.deny("Confirm your email address, then sign in again.");
    return;
  }

  let management;
  try {
    management = new ManagementClient({
      domain: event.secrets.AUTH0_DOMAIN,
      clientId: event.secrets.LINKING_CLIENT_ID,
      clientSecret: event.secrets.LINKING_CLIENT_SECRET
    });

    const { data: matches } = await management.usersByEmail.getByEmail({
      email: event.user.email
    });

    // Only confirmed addresses, and only other accounts.
    const others = matches.filter(
      user => user.email_verified === true && user.user_id !== event.user.user_id
    );
    if (others.length === 0) return;

    // The oldest account survives: it is the one with the history.
    const primary = others
      .concat(event.user)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0];
    if (primary.user_id === event.user.user_id) return;

    const [provider, ...rest] = event.user.user_id.split("|");
    await management.users.link({ id: primary.user_id }, {
      provider,
      user_id: rest.join("|")
    });
    api.authentication.setPrimaryUser(primary.user_id);
  } catch (error) {
    // Deny rather than let a second account be created. A denied login is
    // recoverable in a minute; a split account is not recoverable at all
    // without an operator merging two histories by hand.
    api.access.deny("Sign-in is temporarily unavailable. Please try again.");
  }
};
```

**Its credentials are a machine-to-machine application**, named
`Account Linking (<environment>)`, authorized for the Management API with
exactly `read:users` and `update:users` - nothing else, because nothing else is
needed and this secret lives in an Action. Put the domain, client id and secret
in the Action's own **Secrets**, never in a repository or an env file.

It also needs the `auth0` npm module added under the Action's
**Dependencies**; the code above is written against v4 (`usersByEmail.getByEmail`
returning `{ data }`, `users.link({ id }, { provider, user_id })`). Pin the
version you deploy and note it here, because an Action that throws denies every
login on the tenant.

**Confirm the connection sends the email.** Authentication -> Database ->
`Username-Password-Authentication` -> **Requires Username** / email settings,
and Branding -> Email Templates -> **Verification Email** enabled. Without it
the deny above locks every new password account out permanently.

**What linking does not join.** An Apple sign-in that hides the address behind
a private relay address carries a different address, so it stays a different
account, as documented in `docs/account-switching-guide.md`.

**Before enabling this on a tenant, check who holds the row.** The Action makes
the OLDEST Auth0 user primary, and that is independent of which subject holds
the Letter IRL `users` row - the REST layer opened no account row at all until
2026-09-19, so a person whose first visit was the website has an old Auth0 user
with no row, and their later ChatGPT identity holds the row with the credits in
it. Link those two and the surviving primary subject arrives with no row,
presents an address the other subject still holds, and is answered 409 - with
no way back, because the secondary identity can no longer sign in on its own.

So, per tenant, before the Action goes into the flow:

1. Page `GET /api/v2/users` and group the confirmed addresses yourself - the
   Management API has no group-by. For every address held by more than one
   Auth0 user, note the oldest by `created_at`.
2. For each of those, ask the database which subject holds the row:
   `SELECT user_id FROM users WHERE lower(email) = lower($1)`. The oldest Auth0
   user must be that subject, or the address must have no row at all.
3. Where it is not, the two accounts have to be joined **before** the Action is
   enabled. There is no tool for this yet - the operator `account.merge`
   command is planned, not built - so today it is SQL, by hand, in one
   transaction, and it is not simply `UPDATE users SET user_id`:

   - 13 child tables reference `users(user_id)` `ON DELETE CASCADE` and must be
     re-pointed (`letters`, `orders`, `letter_drafts`, `credit_ledger`,
     `credit_transactions`, `promo_redemptions`, `personal_access_tokens`,
     `feature_requests`, `recent_uploads`, `image_entitlements`,
     `image_generation_reservations`, `gift_letters`,
     `gift_codes.issued_to_user_id`);
   - `commerce_pack_refunds` is `ON DELETE RESTRICT`, so the old row cannot be
     deleted until that one moves;
   - `stripe_disputes` and `gift_codes.redeemed_by_user_id` are
     `ON DELETE SET NULL`, so deleting the old row without moving them first
     silently detaches dispute and redemption history rather than failing;
   - `promo_redemptions` is unique per campaign and user, and `recent_uploads`
     is keyed on the user, so a collision there is a decision, not a move.

4. The check is a snapshot. A row opened under the younger subject between the
   check and the Action going live recreates the hazard, so re-run step 2
   immediately before enabling it - or keep new accounts out in between, which
   on production is what `LETTER_IRL_BETA_ALLOWED_SUBJECTS` already does.

**After anyone is linked, check the subject lists.**
`LETTER_IRL_BETA_ALLOWED_SUBJECTS` and `LETTER_IRL_ADMIN_USER_IDS` name
subjects, and only the surviving primary subject counts afterwards.

### Required Auth0 CIMD Configuration

1. **Client ID Metadata Document registration**
   - Import the current OpenAI-hosted HTTPS CIMD URL manually
     (Applications -> Create Application -> **Import from URL**).
   - Verify authorization code, PKCE S256, and that the callback matches the
     document exactly. The client authentication method is whatever the
     document declares - currently `private_key_jwt` - and is not a choice.
   - `third_party_security_mode: strict` is forced on every CIMD client
     regardless of the tenant's permissive-by-default setting, and cannot be
     changed afterwards. Strict is satisfied by importing, not by configuring.
   - **The import survives connector recreation.** An earlier revision said that
     deleting and recreating the ChatGPT connector mints a new `client.json`
     URL and orphans the import. Observed three times (development twice on
     2026-09-09, production on 2026-09-10): for the same developer account and
     MCP URL, ChatGPT reuses the callback id, the `client.json` URL is
     therefore the same, and Auth0 sends the login page for the previously
     imported client with no new import. The development id recorded in issue
     #160 on 2026-07-18 is still the one in use. The import is required once
     per callback id, not once per connector: a sign-in that fails with
     `invalid_request: Unknown client: https://chatgpt.com/oauth/{id}/client.json`
     is the signal that a genuinely new id appeared, and the Import-from-URL
     step above is the fix. Conversely, a `client.json` URL that has not been
     imported into a tenant is refused outright (HTTP 400 from `/authorize`),
     so the import cannot be skipped.

2. **Dedicated MCP resource/API**
   - Identifier: exact canonical environment `/mcp` URL.
   - Permissions: `mail:read`, `mail:draft`, and `mail:send`.
   - **Enable the Resource Parameter Compatibility Profile** (tenant ->
     Settings -> Advanced). Auth0 does require it: ChatGPT sends `resource` and
     no `audience`, and without the profile Auth0 falls back to the tenant
     Default Audience. While that was the retired `https://letter-irl/api`,
     Auth0 refused with `Client "tpc_..." is not authorized to access resource
     server`. Since 2026-09-14 both tenants' Default Audience names the MCP API,
     so a request that reaches the fallback also gets the right API; keep the
     profile on regardless. The profile is additive - `audience` is still
     checked first, so every existing flow that sends one is unaffected.
   - **Allow Offline Access: enabled.** Without it Auth0 issues no refresh token
     however the client asks, and the connection dies at access-token expiry with
     a human re-consent as the only recovery (issue #160).

2b. **Production tenant status** (built 2026-08-24, issue #158)

   The production tenant had **no MCP API at all** until this date - only the
   legacy `https://letter-irl/api` resource server. That is why production
   advertised `scopes_supported: ["openid","email","profile"]` with no product
   scopes: there were none in the tenant to advertise.

   | Item | State | Verified by |
   |---|---|---|
   | API `Letter IRL MCP`, identifier `https://api.letterirl.com/mcp` | Created | Dashboard, id `6a8bafc38557d1cb6fa22153` |
   | Signing `RS256`, token profile `access_token` | Set | Matches DEV; `validateOAuthConfig` requires RS256 |
   | Access token lifetime 86400 / web 7200 | Set | Read back after reload |
   | **Allow Offline Access** | **Enabled** | Read back after reload |
   | `mail:read` / `mail:draft` / `mail:send` with descriptions | Added | Read back after reload |
   | CIMD registration (tenant Advanced) | **Enabled** | `client_id_metadata_document_supported: true` in published metadata |

2c. **CIMD client imported** (2026-09-05, this tenant)

   The chicken-and-egg in the previous revision - "the CIMD client cannot be
   imported until a production ChatGPT connector exists to publish its
   `client.json`" - was resolved by creating the connector first and letting the
   sign-in fail. The failure named the URL to import:
   `invalid_request: Unknown client: https://chatgpt.com/oauth/{id}/client.json`.

   On 2026-09-10 the production connector was deleted and recreated after the
   promotion that carried #353. The recreated connector received the same
   callback id, so this import was still the client Auth0 resolved, the owner
   signed in without any tenant change, and the connector's Refresh returned
   every tool. Nothing in this table needed to be redone.

   | Item | State | Verified by |
   |---|---|---|
   | CIMD client `ChatGPT`, id `tpc_3e5dGr4xSikvNzScZkiVhd` | Imported | Applications list; Registration Type reads **CIMD** |
   | Third-party mode | **Strict** (forced by CIMD, not configured) | App header badge reads `Third-party`, not `Permissive mode` |
   | Callback | `https://chatgpt.com/connector/oauth/{id}`; the same id was reused when the connector was deleted and recreated on 2026-09-10 | Settings -> Allowed Callback URLs, exact match to the document; login page served for this client on the recreated connector's first link |
   | Client authentication | `private_key_jwt`, two pinned RS256 keys | Import preview mapping; see the corrected contract header |
   | `Letter IRL MCP` user-delegated | **3 / 3** (`mail:read`, `mail:draft`, `mail:send`) | API Access tab |
   | `Letter IRL MCP` client access (M2M) | 0 / 3, deliberately | ChatGPT acts for a user, never as a machine |
   | Auth0 Management API | 0 / 273 | API Access tab |
   | "Always grant all permissions" | **Off** | Consent is the point of a strict third-party client |
   | Resource Parameter Compatibility Profile | **Enabled** | Settings -> Advanced, read back after reload |
   | Domain-level connections | Already enabled before this work | `Promote Connection to Domain Level` true on both `Username-Password-Authentication` and `google-oauth2` |

   The end-to-end proof is the error progression on `/authorize`, each step
   fixing the one named by the last:

   1. `Unknown client: https://chatgpt.com/oauth/{id}/client.json` - no CIMD client.
   2. `Client "tpc_..." is not authorized to access resource server "https://letter-irl/api"`
      - client found, but `resource` ignored in favour of the Default Audience.
   3. `302 Found -> /u/login` - working, with all seven scopes requested.

   **The server side was wrong too, and silently.** Production ran with
   `LETTER_IRL_OAUTH_AUDIENCE=https://letter-irl/api` - the legacy API, not the
   MCP resource - and `LETTER_IRL_OAUTH_SCOPES=openid,email,profile`, so no
   token could have carried `mail:*` and every one of the 22 tools would have
   refused with `insufficient_scope` (`src/auth/toolScopes.ts` maps all of them
   to a product scope). Neither was caught because
   `LETTER_IRL_OAUTH_CIMD_ENFORCEMENT` was `"false"`, and
   `assertValidOAuthConfig()` only runs when it is `"true"`
   (`src/mcp/httpServer.ts:145`) - exactly the failure the comment at
   `src/config/deploymentConfig.ts:289` predicts, "a misconfigured production
   boots clean and serves a broken OAuth surface". The preflight passed it
   because the preflight reads variable names, never values, and the name was
   present.

   Corrected together on 2026-09-05, because no subset works: audience alone
   still fails the scope rules, scopes alone still fails the audience rule, and
   keeping both audiences fails `CIMD mode requires exactly one MCP audience`.
   Verified by running `validateOAuthConfig` against the real values before
   touching Railway, then by `/readyz` returning 200 on the boot that ran the
   assertion for the first time.

   Still outstanding in this tenant:

   - Refresh-token rotation and the 30-day/15-day lifetimes in 2a are client
     settings on the CIMD client and have not been reviewed since the import.
   - The two legacy **permissive** third-party clients (`ChatGPT` static,
     `MCP CLI Proxy`) remain, against the strict contract at the top of this
     document. Both carry user-delegated grants on the Auth0 Management API -
     which is the `current_user` scope set, not tenant administration, so the
     exposure is a user's own profile and identities rather than the tenant.
     Revoking is **not** effective on its own: Auth0 warns the per-app
     configuration "will not be enforced until you switch the API Policy to
     'Per-app authorization'", which is a tenant-wide change affecting every
     application and was deliberately not made in passing.
   - **Dynamic Client Registration: disabled 2026-08-24.** Per the contract above
     it is rollback inventory only, and CIMD now supersedes it. Verified off by
     reading the tenant Advanced setting back after a reload. Note the tenant
     still publishes `registration_endpoint` in its metadata either way - the DEV
     tenant does too - so the published document is NOT a way to check this. Read
     the setting.
   - **`Prod-to-Dev Sync (Management API)`** - client id
     `TZEuAJ6kTYFTXJRtu8fgUlPiqh9FAMMS`. Renamed 2026-08-24 from
     `Letter IRL API (Test Application)`, which was actively misleading: it held
     **Auth0 Management API access (4 of 273 permissions)** and was the client
     `scripts/dev-sync.ts` authenticated as, via `AUTH0_PROD_CLIENT_ID` /
     `AUTH0_PROD_CLIENT_SECRET`, to read production users for the prod-to-dev
     sync. Deleting it as the "test app" it appeared to be would have broken that
     script silently - nothing in the repo names it, only an env var holding its
     id, so searching the codebase for the app name finds nothing.

     **The script was removed on 2026-09-13, so this client now has no caller.**
     Its Management API client access was revoked on 2026-09-14 (now 0 of 273),
     so it can no longer get a token for any API. Delete it, and this entry with
     it, once the tenant logs show no failed token exchange from its client id.

     Its description now says the same thing inside the dashboard, so the next
     person does not have to reconstruct it from grants.

     The rename is safe because `AUTH0_PROD_CLIENT_ID` refers to it by id, and
     the client id is unchanged. Grants verified unchanged afterwards. It holds
     **no** `mail:*` grants (0 of 3 on the MCP API), so it cannot mint tokens
     carrying product scopes.

     **Creating an API creates one of these every time.** The `Letter IRL MCP`
     API created earlier the same day produced `Letter IRL MCP (Test Application)`
     as a side effect; it had zero grants anywhere and was deleted. Check for it
     after any future API creation.

2a. **Refresh token settings on the CIMD client** (owner decision, 2026-08-23)

   Verified live in the DEV tenant on 2026-08-23. Rotation and both lifetimes
   were already configured; only **Allow Offline Access** on the API above was
   off, which is why no refresh token was ever issued.

   | Setting | Value | Why |
   |---|---|---|
   | Allow Refresh Token Rotation | **Enabled** | Each use replaces the token; reuse of a retired one signals theft |
   | Rotation Overlap Period | **0 seconds** | No window in which a retired token still works - the strictest setting |
   | Maximum (absolute) lifetime | **30 days** (2592000s) | An abandoned grant dies within a month |
   | Idle lifetime | **15 days** (1296000s) | A dormant connection lapses sooner than an active one |

   The approved decision said 14 days idle; the tenant already had 15. The
   difference is immaterial to the intent (roughly a fortnight) and the existing
   value was deliberate, so reality is recorded here rather than adjusted to
   match a round number.

   These bound a real exposure: a refresh token carrying `mail:send` is a standing
   ability to spend a customer's credits and post physical mail whenever their
   ChatGPT account asks. Revocation must still take effect immediately - that is
   CIMD-02b in docs/manual-tests.md, and it is the check that keeps this honest.

   The same settings must be applied to the **production** tenant at cutover
   (#158). They are not inherited from DEV.

2d. **Development tenant: the website on the MCP API** (2026-09-14)

   The development website moved onto the development MCP API on this date. The
   table below was read from the tenant dashboard and the running deployments,
   in the same way as 2b and 2c.

   | Item | State | Verified by |
   |---|---|---|
   | API `Letter IRL DEV MCP`, identifier `https://letter-irl-api-development.up.railway.app/mcp` | Existing | Dashboard, id `6a6cd3b3486a4ed1b55f42f2` |
   | API access policy | **Per-app authorization** for user-delegated and client access | API settings |
   | Allow Skipping User Consent / Allow Offline Access | Both **enabled** | API settings |
   | `Letter IRL Website` (`ZQF6j9WoG0097thWKnCJwNyeJZtUlqOX`) user-delegated grant | **3 / 3** (`mail:read`, `mail:draft`, `mail:send`); client access 0 / 3 | API Access tab |
   | Website refresh-token rotation | On; idle 1296000 s, maximum 2592000 s, overlap 30 s | Application settings, saved by the owner |
   | Website grant types | Implicit and Client Credentials removed | Application settings |
   | Railway `mail-letter-irl-website` (development) | `AUTH0_AUDIENCE` = the development `/mcp` resource; `AUTH0_SCOPE` = `openid profile email offline_access mail:read mail:draft mail:send` | `/auth/login` redirects with that audience and scope, and Auth0 answers with its login page |
   | Dashboard end to end | Overview, Letters, Letter Packs, API Tokens and Settings load; the API logs `rest.request` at 200 for each call, with no scope refusals | Signed-in walkthrough and the development API log, after API PR #386 deployed |

   The overlap is 30 s rather than ChatGPT's 0. The dashboard fires parallel
   API calls and the website's Auth0 SDK does not deduplicate refreshes, so 0
   would trip reuse detection and sign the customer out.

   Later the same day, the Default Audience was repointed from
   `https://letter-irl/api` to the development MCP API identifier (read back
   after a reload), and then `https://letter-irl/api` was deleted. Before the
   repoint, a ChatGPT authorize request with neither `resource` nor `audience`
   was refused with `Client "tpc_..." is not authorized to access resource
   server "https://letter-irl/api"`. After it, and again after the deletion,
   that request and the website's sign-in, with and without an audience, reach
   the Auth0 login page with no error.

2e. **Production tenant: the website on the MCP API** (2026-09-14)

   Production followed the same steps on the same day. The table was read back
   in the same way as 2d.

   | Item | State | Verified by |
   |---|---|---|
   | API `Letter IRL MCP`, identifier `https://api.letterirl.com/mcp` | Existing | Dashboard, id `6a8bafc38557d1cb6fa22153` |
   | API access policy | **Per-app authorization** for user-delegated and client access | API settings |
   | Allow Skipping User Consent / Allow Offline Access | Both **enabled** | API settings |
   | `Letter IRL Website` (`wX17u1wOn3XJRVba1ejIappBNpDno3ER`) user-delegated grant | **3 / 3** (`mail:read`, `mail:draft`, `mail:send`); client access 0 / 3 | API Access tab |
   | Website refresh-token rotation | On; idle 1296000 s, maximum 2592000 s, overlap 30 s | Application settings, saved by the owner |
   | Website grant types | Implicit and Client Credentials removed | Application settings |
   | Railway `mail-letter-irl-website` (production) | `AUTH0_AUDIENCE` = `https://api.letterirl.com/mcp`; `AUTH0_SCOPE` as in 2d | `/auth/login` redirects with that audience and scope, and Auth0 answers with its login page |
   | Dashboard end to end | Overview, Letters, Letter Packs, API Tokens and Settings load; the API logs `rest.request` at 200 for each call, with no scope refusals | Signed-in walkthrough, after API promotion PR #388 deployed |
   | Default Audience | Repointed from `https://letter-irl/api` to `https://api.letterirl.com/mcp` | Tenant settings, read back after a reload |
   | `Letter IRL API` (`https://letter-irl/api`) | **Deleted** | APIs list |
   | `Prod-to-Dev Sync (Management API)` | Management API client access revoked (0 / 273); deletion pending, see 2c | API Access tab, read back after a reload |

   After the repoint and the deletion, the website's sign-in and ChatGPT's
   authorize request, both with `resource` and with neither `resource` nor
   `audience`, reach the Auth0 login page with no error.

3. **Domain-Level Connections**
   - **All 5 connections** must have `is_domain_connection: true`
   - **Why:** Third-party clients (like dynamically registered ChatGPT apps) can only use domain-level connections

4. **OpenAI Review Redirect URI** ⚠️
   - **Location:** Applications → Mail Letter IRL → Settings → Allowed Callback URLs
   - **Required URI:** `https://platform.openai.com/apps-manage/oauth`
   - **Why:** OpenAI's app review process uses this redirect URI to test OAuth flows
   - **Reference:** [OpenAI Apps SDK Auth Docs](https://developers.openai.com/apps-sdk/build/auth/)

### Environment Variables (.env)

The MCP server reads these (development tenant values; `.env.dev.example` has
the full list):

```bash
LETTER_IRL_OAUTH_ISSUER=https://dev-ky21dxn3qmi71hjl.us.auth0.com/
LETTER_IRL_OAUTH_AUTH_ENDPOINT=https://dev-ky21dxn3qmi71hjl.us.auth0.com/authorize
LETTER_IRL_OAUTH_TOKEN_ENDPOINT=https://dev-ky21dxn3qmi71hjl.us.auth0.com/oauth/token
LETTER_IRL_OAUTH_JWKS_URI=https://dev-ky21dxn3qmi71hjl.us.auth0.com/.well-known/jwks.json
LETTER_IRL_MCP_RESOURCE=https://letter-irl-api-development.up.railway.app/mcp
LETTER_IRL_OAUTH_AUDIENCE=https://letter-irl-api-development.up.railway.app/mcp
LETTER_IRL_OAUTH_SCOPES=openid,profile,email,offline_access,mail:read,mail:draft,mail:send
```

`LETTER_IRL_OAUTH_AUDIENCE` must name exactly one audience, the MCP resource.

---

## Management via CLI

### Prerequisites

```bash
# Install Auth0 CLI
npm install -g auth0-cli

# Login
auth0 login
```

### Common CLI Commands

```bash
# List all connections
auth0 api get connections

# List all applications
auth0 apps list

# Search users
auth0 users search

# Get tenant settings
auth0 api get tenant/settings

# List APIs
auth0 api get resource-servers
```

---

## Common Operations

### Enable a Connection as Domain-Level

```bash
# Replace CONNECTION_ID with actual connection ID (e.g., con_0TaXOw40EOEjAtWF)
auth0 api patch connections/CONNECTION_ID --data '{"is_domain_connection": true}'
```

**Example - Enable Google:**
```bash
auth0 api patch connections/con_0TaXOw40EOEjAtWF --data '{"is_domain_connection": true}'
```

### Delete a Dynamically Registered ChatGPT Client

```bash
# Get client ID from apps list
auth0 apps list

# Delete by client ID
auth0 apps delete CLIENT_ID --force
```

### Delete All ChatGPT Clients

```bash
# Get all ChatGPT client IDs
auth0 apps list --json | jq -r '.[] | select(.name == "ChatGPT") | .client_id'

# Delete them (example)
for client_id in $(auth0 apps list --json | jq -r '.[] | select(.name == "ChatGPT") | .client_id'); do
  auth0 apps delete "$client_id" --force
done
```

### Create a Test User

```bash
auth0 users create \
  --connection "Username-Password-Authentication" \
  --email "test@example.com" \
  --password "SecurePassword123!"
```

### Delete a User

```bash
# Search for user
auth0 users search

# Delete by user ID (quote to handle pipe character)
auth0 users delete "auth0|USER_ID" --force
```

### View Connection Details

```bash
# Get full configuration for a specific connection
auth0 api get connections/con_0TaXOw40EOEjAtWF | jq '.'
```

### Check Auth0 Logs (Recent Activity)

```bash
auth0 api get logs | jq '.[] | {type, description, date, client_name, user_name}'
```

---

## Troubleshooting

### Issue: "no connections enabled for the client"

**Solution:** Ensure the connection has `is_domain_connection: true`:

```bash
auth0 api get connections/CONNECTION_ID | jq '{name, is_domain_connection}'
```

### Issue: "dynamic client registration is disabled"

**Solution:** Enable DCR in Auth0 Dashboard:
1. Settings → Advanced
2. Enable "OIDC Dynamic Application Registration"

### Issue: ChatGPT shows "Something went wrong with setting up the connection"

**Check:**
1. Auth0 logs: Auth0 Dashboard → Monitoring → Logs
2. MCP server logs: Check terminal output or `/debug/logs` endpoint
3. Verify all 5 connections are domain-level

### Issue: Social login not appearing in Auth0 Universal Login

**Check:**
1. Connection is enabled: `auth0 api get connections/CONNECTION_ID`
2. Connection has `is_domain_connection: true`
3. Developer credentials are configured for the social provider (in Auth0 Dashboard)

---

## Security Best Practices

1. **Rotate Management API Tokens Regularly**
   - Management API tokens have extensive permissions
   - Use short-lived tokens when possible
   - Store securely (never commit to git)

2. **Enable MFA for Username-Password Auth**
   - Already configured in `Username-Password-Authentication` connection
   - Users can enroll via Auth0 Universal Login

3. **Monitor Auth0 Logs**
   - Check for failed login attempts
   - Monitor for suspicious token exchanges
   - Review dynamically registered clients periodically

4. **Use Environment Variables**
   - Never hardcode Auth0 credentials
   - Use `.env` files (add to `.gitignore`)
   - Validate all required env vars on startup

---

## Environment Configuration

### Current State: Dual Tenants

Letter IRL uses separate Auth0 tenants for complete environment isolation:

| Environment | Auth0 Tenant | Account | Purpose |
|-------------|--------------|---------|---------|
| **Production** | `dev-njmdyqf8n25rqgy7.us.auth0.com` | dnicholl@letterirl.com | Live users, real payments |
| **Development** | `dev-ky21dxn3qmi71hjl.us.auth0.com` | dnicholl@objective.works | Testing, sync from production |

### Configuration Parity Checklist

When updating development, ensure production is also updated:

1. **Connections** - All 5 identity providers with `is_domain_connection: true`
2. **DCR** - Off; rollback inventory only (CIMD registration on)
3. **Default Audience** - The MCP API identifier (both tenants repointed 2026-09-14)
4. **Applications** - Create equivalent apps with appropriate callbacks; authorize the website application for the MCP API
5. **APIs** - The MCP API, identifier = the environment's canonical `/mcp` URL, with `mail:read`, `mail:draft` and `mail:send`
6. **Branding** - Logo, colors, friendly name (see Branding Checklist above)

### Environment Variables by Tenant

```bash
# Production (.env)
LETTER_IRL_OAUTH_ISSUER=https://dev-njmdyqf8n25rqgy7.us.auth0.com/
LETTER_IRL_OAUTH_JWKS_URI=https://dev-njmdyqf8n25rqgy7.us.auth0.com/.well-known/jwks.json
LETTER_IRL_OAUTH_AUDIENCE=https://api.letterirl.com/mcp

# Development (.env.dev)
LETTER_IRL_OAUTH_ISSUER=https://dev-ky21dxn3qmi71hjl.us.auth0.com/
LETTER_IRL_OAUTH_JWKS_URI=https://dev-ky21dxn3qmi71hjl.us.auth0.com/.well-known/jwks.json
LETTER_IRL_OAUTH_AUDIENCE=https://letter-irl-api-development.up.railway.app/mcp
```

### Applying Branding to Production

When ready to apply branding to production, switch to the production tenant and run these commands:

```bash
# Switch to production tenant
auth0 tenants use dev-njmdyqf8n25rqgy7.us.auth0.com

# Set tenant friendly name
auth0 api patch "tenants/settings" --data '{"friendly_name": "Letter IRL"}'

# Set branding (logo, favicon, colors)
auth0 api patch "branding" --data '{
  "logo_url": "https://letterirl.com/logo.jpg",
  "favicon_url": "https://letterirl.com/favicon.ico",
  "colors": {
    "primary": "#1a8ccc",
    "page_background": "#ffffff"
  }
}'

# Update the ChatGPT MCP app with name and logo
# NOTE: First find the ChatGPT MCP client ID in production tenant:
auth0 apps list
# Then patch it (replace CLIENT_ID with actual ID):
auth0 api patch "clients/CLIENT_ID" --data '{
  "name": "Letter IRL",
  "logo_uri": "https://letterirl.com/logo.jpg"
}'

# Switch back to development tenant
auth0 tenants use dev-ky21dxn3qmi71hjl.us.auth0.com
```

---

## References

- [Auth0 Documentation](https://auth0.com/docs)
- [Auth0 CLI Reference](https://auth0.github.io/auth0-cli/)
- [RFC 7591: Dynamic Client Registration](https://datatracker.ietf.org/doc/html/rfc7591)
- [OAuth 2.1 Specification](https://oauth.net/2.1/)
- [ChatGPT Apps SDK - MCP Server](https://developers.openai.com/apps-sdk/build/mcp-server/)
- [Letter IRL OAuth Learnings](./learnings/chatgpt-auth0-oauth-learnings.md)

---

## Changelog

### December 29, 2025
- Added Tenants Overview section at top (both dev and prod tenants)
- Added Branding Checklist section with dev/prod status tracking
- Added "Applying Branding to Production" section with CLI commands
- Updated Environment Configuration to reflect dual-tenant reality
- Applied branding to development tenant:
  - Friendly name: "Letter IRL"
  - Logo: https://letterirl.com/logo.jpg
  - Favicon: https://letterirl.com/favicon.ico
  - Primary color: #1a8ccc
  - ChatGPT MCP app renamed to "Letter IRL" with logo

### December 23, 2025
- Added Quick Reference: Application Configuration Matrix
- Added Tenant-Level Settings Checklist
- Added Environment Configuration section for dev/prod parity
- Added OpenAI app review callback (`platform.openai.com/apps-manage/oauth`)
- Updated references to new learnings folder structure

### November 14, 2025
- Initial documentation created
- Enabled domain-level connections for Google, Microsoft, Apple, GitHub
- Cleaned up 16 old dynamically registered ChatGPT clients
- Cleared test users for fresh authentication testing
- Verified all 5 authentication methods working with ChatGPT MCP server
