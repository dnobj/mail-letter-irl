# The OIDC Checkbox That Blocked Every First ChatGPT Link

**Date:** 2026-09-22 · **Issue:** #424 · **Status:** fixed by a connector setting; nothing deployed

## Symptom

From ChatGPT's multi-account rollout on 2026-09-17 until this was found, every *first* link of
Letter IRL in ChatGPT failed with "We couldn't connect this account. Please try again.", on
development and production:

- Auth0 logged **Success Login** and **Success Exchange** for the ChatGPT client.
- Our API logged nothing: ChatGPT never opened an MCP session.
- ChatGPT's own callback, `POST /backend-api/aip/connectors/links/oauth/callback`, answered `400`
  with `error_code: OAUTH_OWNER_PROFILE_ID_MISSING` and `account_position_bucket: "first"`.

Existing links kept working, because a link is never re-created. Removing one (Uninstall) meant it
could not be re-established.

## Cause

Two facts, each documented on its own side:

1. **ChatGPT.** New Plugin → **Advanced OAuth settings** → **OIDC enabled** is pre-ticked whenever
   the authorization server publishes OpenID discovery, and Auth0 always does. With it on, ChatGPT
   needs an OIDC identity (an ID token) inside its callback, before it contacts the MCP server, to
   record which account the link belongs to.
2. **Auth0.** A CIMD client is always a strict third-party client: "Permissive mode is not
   available for CIMD clients" ([Register Applications with
   CIMD](https://auth0.com/docs/get-started/auth0-overview/create-applications/register-applications-with-cimd)).
   And "Third-party applications with enhanced security controls do not support OIDC scopes
   (`openid`, `profile`, `email`) in this release"; "The consent dialog shows API scopes only"
   ([User Consent and Third-Party
   Applications](https://auth0.com/docs/get-started/applications/confidential-and-public-applications/user-consent-and-third-party-applications)).

So ChatGPT asked for `openid profile email`, Auth0 granted only
`mail:read mail:draft mail:send offline_access` and returned no ID token, and ChatGPT refused the
link. Before 2026-09-17 ChatGPT did not need that identity, so the same mismatch did no harm.

## Proof, one setting at a time

The same MCP server and Auth0 tenant throughout. The first two rows also share one imported client.

| Connector | OIDC enabled | ChatGPT's callback |
|---|---|---|
| fresh hostname | on (the default) | `400 OAUTH_OWNER_PROFILE_ID_MISSING` |
| same hostname, same client | off | `424 MCP_ACTION_DISCOVERY_FAILED`, "Authentication succeeded" - stopped by our `LETTER_IRL_ALLOWED_HOSTS`, as a throwaway hostname should be |
| canonical development URL | off | `200`, linked |
| production URL, no profile tool deployed | off | `200`, linked |

With OIDC off, the development link ran `initialize`, `tools/list`, the widget `resources/read`
calls, then `tools/call get_profile`, and ChatGPT stored the tool's answer as the link's
`owner_profile`. Production, which had no profile tool yet, linked with `owner_profile: null`. A
tool call afterwards worked on both.

## The fix

Untick **OIDC enabled** whenever a Letter IRL connector is created - development and production
developer-mode connectors alike - and in the published app's OAuth settings. Leave everything else
at its default: CIMD registration, the default scopes, empty base scopes.

What OIDC off gives up: Enterprise workspace domain restrictions, which need OIDC and the UserInfo
endpoint, and the `id_token_hint` ChatGPT can send on a reconnect. Revisit when Auth0 ships OIDC
for third-party applications. Leaving CIMD for a permissive client to get OIDC back is not worth
it: CIMD is the registration method OpenAI recommends.

## How it was misread first, and what to read instead

For four days the failure was put down to ChatGPT not requesting `openid` (#424's first title,
#425). That was read from the Auth0 grant - Users → Authorized Applications, and
`details.prompts[].grantInfo.scope` in the login log - which for a strict client never lists an
OIDC scope, whatever was requested. The instrument could not show the thing being measured.

Read ChatGPT's own traffic instead, in the browser tab that runs the link:

- the start call, `POST /backend-api/aip/connectors/links/oauth`: its `redirect_url` carries the
  exact `scope` ChatGPT requests;
- the callback, `POST /backend-api/aip/connectors/links/oauth/callback`: its body names the error,
  or on success the link's `requested_scopes`, granted `scopes` and `owner_profile`;
- `POST /backend-api/aip/connectors/batch`: the connector's `oidc_enabled`, its default and base
  scopes, and `supports_oauth_owner_profile_id`.

Read the callback body before the tab navigates away; it is lost afterwards.

## Also learned on the way

- A new MCP hostname gets a new CIMD client id (`https://chatgpt.com/oauth/<id>/client.json`),
  which Auth0 refuses as "Unknown client" until it is imported. The same hostname keeps its id
  across connector recreation.
- A developer-mode connector must be attached (the composer's **+** menu) in a chat's first
  message, or its tool calls fail with "This conversation does not support developer MCPs".
- ChatGPT does open an MCP session during a link, after the identity step. It was never seen
  before because the identity step was failing first.

## Related

- [OAuth Metadata Is a Contract](oauth-metadata-is-a-contract.md) - how ChatGPT builds its scope
  request
- [auth0-tenant-configuration.md](../auth0-tenant-configuration.md) - the CIMD import and strict
  mode
- [manual-tests.md](../manual-tests.md) - the OAuth flow and LINK-01 step 7
