# Where the client actually reads your scopes

**Date:** 2026-08-23
**Context:** issue #160, PRs #266 and follow-up

## What happened

The DEV connection died every time the access token expired. Recovery required
a human clicking Reconnect and re-consenting, which also meant no unattended
test of this surface could outlive a token lifetime.

Refresh tokens require `offline_access`, and `offline_access` appeared nowhere
in `src/`. So the fix looked obvious. It took **three attempts** to find the
real cause, and the two wrong ones are the useful part of this note.

### Attempt 1 — the tenant

Enabled *Allow Offline Access* on the Auth0 API (it was off), advertised
`offline_access` in `scopes_supported`, redeployed, revoked the grant,
reconnected.

Still expired. The Auth0 authorize log showed what the client had actually
asked for:

```json
"grantInfo": { "scope": "mail:draft mail:read mail:send" }
```

### Attempt 2 — the authorization-server metadata

DEV runs static-DCR compatibility, so `oauth-protected-resource` names *this
server* as the authorization server and ChatGPT reads our
`openid-configuration` for the server's capabilities. It said
`grant_types_supported: ["authorization_code"]` — no `refresh_token` — while
`/oauth/register` was simultaneously telling the same client
`["authorization_code", "refresh_token"]`. Two hand-written lists that had
drifted, and nothing compared them.

A real defect, worth fixing, and **not the cause**. Fixed, deployed, refreshed
the connector, revoked, reconnected.

Still expired. Same grant scope.

### What it actually was

The connector settings page, per tool:

```
clear_return_address   Required scopes  mail:draft
SECURITY SCHEMES { "type": "oauth2", "scopes": ["mail:draft"] }
```

**ChatGPT builds its authorization request from the union of the per-tool
`securitySchemes` scopes — not from `scopes_supported`.**

That union was exactly `mail:read mail:draft mail:send`. Exactly what every
grant recorded. It also explains something that had been true and unremarked
for months: `openid`, `profile`, and `email` were advertised and never
requested either, because no tool declares them.

`offline_access` was advertised in three places the client does not consult for
this purpose — protected-resource metadata, `openid-configuration`, and the 401
`WWW-Authenticate` challenge — and requested from none of them.

Downstream: no `offline_access` → Auth0 issues no refresh token → at expiry
ChatGPT has nothing to refresh with, so it never calls the token endpoint at
all. The Auth0 log recorded **zero** refresh exchanges, successful or failed.
That silence was the strongest single piece of evidence, and it is the thing to
look for first next time: *did the client even try?*

## The lessons

**1. Advertising a capability is not the same as being asked for it. Find the
channel the client actually reads.** Three correct-looking advertisements
achieved nothing. The one that mattered was a per-tool field. When a client
isn't asking for something, enumerate every place it could be learning what to
ask for, and check which one its behaviour actually matches — here the
requested set matched the tool union *exactly*, which was the fingerprint that
cracked it.

**2. Prefer evidence of absence over evidence of configuration.** Attempts 1
and 2 both ended with "the config is now correct" and a failing test. What
finally moved things was a log that showed the client making *no request at
all*.

**3. One function answering two questions is a latent bug.**
`getRequiredToolScopes` was serving both "what does this tool enforce on every
call" and "what does the client ask the user to grant." Those diverge the
moment you need a scope that is requested but never enforced. Session scopes
are exactly that, and there was no way to express one.

**4. Fixing a real defect is not evidence that you fixed *the* defect.** The
`grant_types_supported` contradiction was genuine and is now impossible to
reintroduce (both sites read `SUPPORTED_GRANT_TYPES`). It also had nothing to
do with the symptom. Correct-and-irrelevant is a common and seductive outcome;
only the behavioural test distinguishes it from correct-and-sufficient.

## Confirmed

Fixed and proven on DEV, 2026-08-23. With the access-token lifetime temporarily
at 300s: consent screen showed **Allow offline access**, the grant recorded
`mail:read mail:draft mail:send offline_access`, and a tool invoked ~22 minutes
past expiry succeeded with no prompt - Auth0 logging
`Successful Refresh Token exchange` (`policy_used: refresh_token_user_grant`,
`tokenCounter: 2`, so rotation is live). The log had recorded **zero** refresh
exchanges of any kind before this.

## A second trap: a deploy does not reach the client

After the fix deployed, the connector still advertised the old scopes. The
connector holds a **pinned app-version snapshot**; only **Refresh** re-ingests
tool schemas from the live server.

The trap: **Refresh is not rendered while the connector is disconnected.**
Several test cycles were spent clicking it in that state, doing nothing, so the
schema stayed pinned to a July snapshot and none of the deploys reached ChatGPT
at all. Reconnect first, then Refresh.

Confirm by reading the tool's `SECURITY SCHEMES` block on the connector page.
The App Version Id does **not** change when a refresh lands, so it is not a
usable signal.

## The shape of the fix

- `securitySchemes` scopes = enforced scopes **+** session scopes.
- `getRequiredToolScopes` unchanged — PAT callers authorize with no scopes at
  all, so a tool demanding `offline_access` would deny them permanently.
- Applied to every tool: a typed @-mention scopes the turn's toolset, so a
  session scope on only some tools would be requested only sometimes.
- Both halves pinned by tests, because dropping either breaks a different thing
  in a way that is quiet.

## Related

- `docs/learnings/dcr-static-client-workaround.md` — why DEV is in static-DCR mode
- `docs/learnings/chatgpt-auth0-oauth-learnings.md`
- `docs/auth0-tenant-configuration.md` — the tenant half
