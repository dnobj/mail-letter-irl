# Letter IRL Admin Panel

**Last updated:** September 6, 2026

The admin panel is a separate Railway service in each environment, built from this repository with
`Dockerfile.admin` and `railway.admin.toml`. It has no public domain and no inbound port: the container
runs `tailscaled` in userspace-networking mode next to the Node process and publishes the panel to the
owner's tailnet with Tailscale Serve, so the only path to it is a WireGuard tunnel from an approved
device on that tailnet, at `https://letter-irl-admin-<dev|prod>.<tailnet>.ts.net`.

It replaces the legacy `admin-panel.html` page and `/api/admin/*` routes, which stay disabled everywhere
(`src/mcp/legacyAdminRoutes.ts`). Issue [#162](https://github.com/dnobj/mail-letter-irl/issues/162) tracks
the rebuild.

## What it shows and never shows

Read-only pages (slice 1): an operations overview; exact-identifier lookup; account detail with ledger
lots and per-lot remaining letters, orders with refund state, letters with outbox state, image quota,
promo redemptions and token metadata; order detail with the pack figures an operator needs before touching
Stripe (letters in the pack, unspent letters, letters sent from it, per-letter price, maximum proportional
refund); the operational alert queue and unmatched webhook events; held, failed and stale jobs; disputes
and accounts with sends blocked; maintenance health; and the audit and command history.

The panel never renders letter content, recipients, return addresses, draft bodies or images, token
hashes or quarantined content. That is enforced below the application: the reader role it connects as
has column-level `SELECT` on `users`, `letters`, `letter_drafts`, `personal_access_tokens`,
`feature_requests` and `redacted_content_quarantine` that omits those columns
(`src/admin/provisioning.ts`), and `tests/integration/adminReadModels.postgres.test.ts` proves a
`SELECT content FROM letters` fails as that role. An email address is masked until an operator reveals it
with a reason, which writes a `pii.reveal` audit event.

## How a request is authenticated

Every request to an application route must pass all of these, on every request, with no exception for a
session cookie:

1. It arrived on the loopback listener (`127.0.0.1:ADMIN_APP_PORT`). Nothing but the local Serve proxy
   can reach it; the health listener on `[::]:PORT` serves `/healthz` and nothing else.
2. It carries no `Tailscale-Funnel-Request` header, and Funnel is never granted in the policy.
3. It carries `Tailscale-User-Login`, which Serve sets from its own whois of the peer and strips from
   inbound requests.
4. `X-Forwarded-Host` equals the node's own MagicDNS name (DNS-rebinding defence).
5. The login is listed in `ADMIN_OPERATOR_LOGINS`, compared exactly.
6. For a new session, `tailscale whois` of the peer address agrees with the header; tagged peers are
   refused. The session (cookie `__Host-lirl_admin`, in memory, 15-minute idle and 8-hour absolute expiry)
   is bound to the login and peer address; any mismatch destroys it.

State-changing requests additionally need `Sec-Fetch-Site` of `same-origin` or `none`, an `Origin` equal
to the panel's origin, and the per-session CSRF token in the form. Responses carry a strict nonce-based
Content Security Policy, `Cache-Control: no-store` and a correlation id. Denials, failures, session starts
and reveals all write `admin_audit_events`, which is append-only at the database.

Commands (slice 2 onwards) require `ADMIN_MODE=full`, a current TOTP elevation and a typed confirmation
phrase; in `read-only` mode both connection strings point at the reader role, so an accidental write fails
at PostgreSQL as well as at the route.

## One-time setup for the development environment

### 1. Database roles

In the Neon SQL editor on the **development** branch, as the owner role, create the two login roles.
Console-created roles get `neon_superuser`, so these must be created with SQL. Choose the passwords in a
password manager; they are never committed, printed or pasted into chat.

```sql
CREATE ROLE letter_irl_admin_reader_development LOGIN PASSWORD '<reader password>';
CREATE ROLE letter_irl_admin_operator_development LOGIN PASSWORD '<operator password>';
```

Then grant, from a workstation, with the owner connection string in the transient
`LETTER_IRL_ADMIN_PROVISIONING_DATABASE_URL` variable and a non-secret config file such as
`%LOCALAPPDATA%/LetterIRL/admin/development.json`:

```json
{
  "version": 1,
  "environment": "development",
  "displayName": "Letter IRL Development",
  "database": {
    "hostname": "<neon development hostname>",
    "name": "<database name>",
    "marker": "development",
    "readerRole": "letter_irl_admin_reader_development",
    "operatorRole": "letter_irl_admin_operator_development"
  },
  "integrations": { "stripeMode": "test", "postGridMode": "dummy" },
  "allowedModes": ["read-only", "full"]
}
```

```bash
npm run admin:provision-access -- --environment development --config "%LOCALAPPDATA%/LetterIRL/admin/development.json" --apply
```

The script inserts the environment marker if absent, refuses a database that has not reached migration
029, verifies TLS, and applies the grants idempotently. Re-run it after any migration that adds a table
the panel reads.

### 2. Tailscale console

- DNS page: enable MagicDNS and HTTPS certificates (this publishes the node names to Certificate
  Transparency; they carry no secret).
- Access controls: add the tags, posture, grants and tests below to the policy file. No rule may name
  `tag:dev-admin` or `tag:prod-admin` as a source, and the initial catch-all rule must be replaced by
  explicit grants before the node joins.
- Settings: set key expiry to 30 days; enable Tailnet Lock (two non-Android signing nodes, disablement
  secrets kept offline) or, if that is not possible, device approval. The two are mutually exclusive.
- Keys: generate a one-off auth key: reusable **off**, ephemeral **off**, pre-approved **on**, tag
  `tag:dev-admin`, expiry 1 day. With Tailnet Lock, pre-sign it (`tailscale lock sign <key>`).

```jsonc
{
  "tagOwners": {
    "tag:prod-admin": ["autogroup:admin"],
    "tag:dev-admin":  ["autogroup:admin"]
  },
  "postures": {
    "posture:operatorDevice": [
      "node:os IN ['windows', 'android']",
      "node:tsVersion >= '1.100.0'"
    ]
  },
  "grants": [
    { "src": ["<owner login>"], "dst": ["tag:prod-admin"], "ip": ["tcp:443"], "srcPosture": ["posture:operatorDevice"] },
    { "src": ["<owner login>"], "dst": ["tag:dev-admin"],  "ip": ["tcp:443"], "srcPosture": ["posture:operatorDevice"] }
  ],
  "tests": [
    { "src": "<owner login>", "accept": ["tag:prod-admin:443", "tag:dev-admin:443"], "deny": ["tag:prod-admin:8790", "tag:prod-admin:22"] },
    { "src": "tag:dev-admin",  "deny": ["tag:prod-admin:443"] },
    { "src": "tag:prod-admin", "deny": ["tag:dev-admin:443"] }
  ]
}
```

The owner login is the value the policy uses for the identity provider: `user@example.com` for email
identities, `username@github` for GitHub, `username@passkey` for Tailscale passkeys. The same value goes
in `ADMIN_OPERATOR_LOGINS`.

### 3. Railway service

In the **development** environment, create a service named `letter-irl-admin` from this repository on the
`dev` branch, then:

- Settings: set the config-as-code file path to `railway.admin.toml`; generate **no** domain; keep
  Serverless **off** (a sleeping node never wakes for tailnet traffic); add a volume mounted at `/data`
  (the smallest size is ample).
- Variables, per the table below. `TS_AUTHKEY` is set for the first boot only and deleted once the machine
  appears in the Tailscale console.

| Variable | Value |
| --- | --- |
| `LETTER_IRL_DEPLOYMENT_ENVIRONMENT` | `development` |
| `NODE_ENV` | `production` (as every deployed service) |
| `ADMIN_MODE` | `read-only` |
| `ADMIN_OPERATOR_LOGINS` | the owner login, comma-separated if several |
| `ADMIN_READER_DATABASE_URL` | reader role, pooled Neon hostname of the development branch |
| `DATABASE_URL` | the same reader URL in read-only mode; the operator URL in full mode |
| `ADMIN_SESSION_SECRET` | 32 or more random characters, different per environment |
| `ADMIN_TOTP_SECRET` | required in full mode only; from `npm run admin:totp-enrol` |
| `PORT` | `8080` (the health listener; set it if Railway does not inject one) |
| `ADMIN_APP_PORT` | `8790` |
| `ADMIN_TS_HOSTNAME`, `ADMIN_TS_TAG`, `ADMIN_TS_STATE_DIR` | optional; default to `letter-irl-admin-dev`, `tag:dev-admin`, `/data/tailscale` |
| `STRIPE_SECRET_KEY` | a **restricted** test-mode key (Checkout Sessions read, Refunds read/write, Charges read, PaymentIntents read, Disputes read); needed from slice 3 |
| `LETTER_PROVIDER` and provider keys | as the API service, for the banner and later slices |
| `TS_AUTHKEY` | the one-off key, first boot only |

The service must **not** receive the API's owner `DATABASE_URL`.

### 4. First boot

Read the deploy log. The supervisor prints `[tailscale] backend=...` lines while the node registers, then
`[tailscale] ready name=letter-irl-admin-dev.<tailnet>.ts.net tags=tag:dev-admin`, then
`admin.listening`. The healthcheck passes once the node is Running, Serve is configured and the database
identity checks passed. Then:

1. In the Tailscale console, confirm the machine `letter-irl-admin-dev` shows `tag:dev-admin` and no
   "Locked out" badge.
2. Delete `TS_AUTHKEY` from the service variables (the log warns while it is still set).
3. Open the URL from the laptop. The banner shows `development`, `read-only`, the marker, the reader role,
   the Stripe key mode, the mail provider, the node name and tag, and the build commit.
4. Run `ADMIN-INFRA-01` and `ADMIN-READ-01` to `ADMIN-READ-06` in [manual-tests.md](manual-tests.md).

If Serve cannot be reached from the tailnet on Railway, stop: the fallback is Cloudflare Access with a
tunnel, which changes only `src/admin/http/tailscaleAuth.ts` and the ingress.

## Production gates

Production is provisioned only after three separate owner approvals, each recorded in the incident log:

1. **Read-only connection**: production roles created by SQL, grants applied with
   `--confirm-production-access`, the production node registered with `tag:prod-admin`, `ADMIN_MODE`
   `read-only`; then `ADMIN-PROD-RO-01`.
2. **Full mode**: a restricted live Stripe key created, the production node signed or approved and its
   tag verified, `ADMIN_TOTP_SECRET` enrolled, `DATABASE_URL` switched to the operator role.
3. **First command**: reversible (an alert acknowledgement), never a refund.

## Local development

Copy `.env.admin.example` to `.env.admin.local`, fill in the development reader URL and a session secret,
and run:

```bash
npm run admin:dev
```

This builds, then starts the panel in `local-dev` mode on `http://localhost:8790` with the configured
login standing in for the Serve proxy. Local-dev mode is refused on Railway, under
`NODE_ENV=production`, and outside the development environment. There is no Tailscale involvement.

## Runbook

| Situation | Steps |
| --- | --- |
| Re-register the node (volume replaced, tag changed, suspected key compromise) | Delete the old machine in the console; mint a new one-off, tagged, pre-approved (pre-signed with Tailnet Lock) key with 1-day expiry; set `TS_AUTHKEY`; redeploy; confirm the name and tag; delete the variable. No standing key exists to rotate. |
| Revoke a device (lost or stolen laptop or phone) | Delete the device on the Machines page (immediate); if it was a Tailnet Lock signing node, remove and rotate it from another signing node and re-issue disablement secrets; restart the admin service, which drops every session; if the identity provider account may be compromised, rotate its credential and passkeys and review the console audit log. |
| Panel unreachable | Read the deploy log. `NeedsLogin` on first boot: the one-off key expired, mint again. "Locked out": sign the node. Device approval pending: approve. Volume detached: re-register. `ADMIN_TAILSCALE_TAG_MISMATCH` or `ADMIN_TAILSCALE_NAME_MISMATCH`: the node carries the wrong tag or name; fix the key's tag or the hostname variable. `ADMIN_PUBLIC_DOMAIN_PRESENT`: a domain was generated; remove it. Serverless enabled: disable it. |
| Reach the panel from the phone | Install Tailscale, sign in with the same identity, approve or sign the phone from the laptop, open the URL. Keep the TOTP authenticator on a different device from the one browsing when writes are intended. |
| Certificate problems | Serve requests and renews the certificate itself. Confirm HTTPS is enabled on the DNS page and the node name is unchanged, then redeploy. |
| Block everyone instantly | Remove the grant line from the policy, or delete the machine from the Machines page, or set `ADMIN_MODE=read-only` and redeploy. |
| Rollback | Redeploy the previous image; the node identity persists on the volume. Audit tables are never dropped. |

## Audit

Every session start, denial, elevation, command and reveal writes `admin_audit_events` (append-only,
proven by `tests/integration/admin/adminFoundationDatabase.test.ts`), with the operator's login, display
name and node. Commands also write `admin_command_runs` and the domain's own hashed
`commerce_operator_audit_events` where one exists. Nothing logs secrets, session ids, addresses or
content. The Tailscale console keeps a 90-day configuration audit log of policy, key and device changes.

## Ownership boundary

The provisioning script never creates a role, generates a password or prints a credential. Database and
provider credentials live in Railway variables and password managers only, never in `.env`, command
arguments, logs or screenshots. Break-glass access (the Neon console, `railway run`) remains outside the
panel and is recorded in the incident log.
