# The client believes your OAuth metadata

**Date:** 2026-08-23
**Context:** issue #160, PR #266

## What happened

The DEV connection died every time the access token expired. Recovery required a
human clicking Reconnect and re-consenting, which also meant no unattended test
of this surface could outlive a token lifetime.

The diagnosis looked obvious. Refresh tokens require `offline_access`, and
`offline_access` appeared nowhere in `src/`. So: enable *Allow Offline Access*
on the Auth0 API, add the scope to the advertised list, redeploy, reconnect.

It did not work. The session expired anyway.

The Auth0 authorize log recorded what the client had actually asked for:

```json
"grantInfo": {
  "audience": "https://letter-irl-api-development.up.railway.app/mcp",
  "scope": "mail:draft mail:read mail:send"
}
```

No `offline_access` — despite the server advertising it, and the consent screen
confirmed it: only Read, Draft, Send.

## The actual cause

DEV runs in static-DCR compatibility mode, which makes
`/.well-known/oauth-protected-resource` name **this server** as the
authorization server:

```json
"authorization_servers": ["https://letter-irl-api-development.up.railway.app"]
```

So ChatGPT reads *our* `/.well-known/openid-configuration` to learn what the
authorization server can do — not Auth0's. And ours said:

```json
"grant_types_supported": ["authorization_code"]
```

A client told the server cannot redeem a refresh token has no reason to ask for
one. It was behaving correctly. We were the ones declining a capability we had.

Worse, `/oauth/register` was telling the same client the opposite in the same
session: `grant_types: ["authorization_code", "refresh_token"]`. Two lists,
authored independently, drifted apart, and nothing compared them.

## The lesson

**Advertised capability is a contract, and a well-behaved client will hold you
to it — including by declining to ask for things you said you cannot do.**

That makes a certain class of bug invisible from the server side: nothing errors,
nothing logs, the client simply and silently does less. The symptom surfaces
somewhere else entirely (here: a connection that "randomly" expires), which is
why the first diagnosis went to the tenant configuration instead of to our own
metadata document.

Two habits fall out of it:

1. **When a client isn't doing something you expect, check what you told it you
   support** before checking the thing you expect it to do. The metadata
   endpoints are cheap to `curl` and are the client's entire picture of you.
2. **Any capability declared in two places must be declared once and read
   twice.** `SUPPORTED_GRANT_TYPES` now feeds both the metadata document and the
   registration response. The contradiction is not merely fixed; it is no longer
   expressible.

## Corollary about the first fix

`offline_access` in `scopes_supported` was necessary but inert on its own. Two
settings that only work as a pair, in different files, with no test binding
them, is a trap — so the regression test asserts both together and explains why
either alone does nothing.

## Related

- `docs/learnings/dcr-static-client-workaround.md` — why DEV is in static-DCR mode
- `docs/learnings/chatgpt-auth0-oauth-learnings.md`
- `docs/auth0-tenant-configuration.md` — the tenant half of the fix
