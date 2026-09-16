# Local Setup and Testing

**Last Updated:** September 16, 2026
**Purpose:** Run the Letter IRL API locally and exercise its MCP tools

---

## Overview

This guide covers running the server on a workstation. The full developer guide is
[docs/development.md](docs/development.md); environment files are explained in
[docs/env-files.md](docs/env-files.md).

The ChatGPT authentication path (Auth0 CIMD, exact `/mcp` audience, `mail:*` scopes) is bound to each
environment's canonical URL: the Auth0 API identifier must equal the server's `/mcp` resource. That is
why end-to-end ChatGPT testing, including OAuth linking and widgets, runs against the deployed
development API (`https://letter-irl-api-development.up.railway.app/mcp`), not against a workstation.
See [docs/auth0-setup.md](docs/auth0-setup.md).

## 1. Install and configure

Requires Node.js 22 and a PostgreSQL database: an empty Neon `dev` branch or a local server. Never
point a workstation at the production database.

```bash
npm ci
cp .env.example .env
npm run db:migrate
```

For tool testing without an identity provider, set `LETTER_IRL_REQUIRE_AUTH=false` in `.env`. Every
call then runs as `LETTER_IRL_DEFAULT_USER_ID` (default `mcp-user`). Production refuses to boot with
this setting.

To make sure nothing is mailed, use the dummy provider. Setting `LETTER_PROVIDER=dummy` is **not
enough** on its own: migration 015 seeds `provider_routing` with `postgrid` for every mail type, and
those rows win. [docs/testing-dummy-provider.md](docs/testing-dummy-provider.md) shows both steps.

## 2. Start the server

```bash
npm run dev
```

The server binds `0.0.0.0` on `PORT`, else `LETTER_IRL_HTTP_PORT`, else 8090. `.env.example` sets 8788.

## 3. Check it

```bash
curl http://localhost:8090/healthz
curl http://localhost:8090/readyz
curl http://localhost:8090/.well-known/oauth-protected-resource
curl http://localhost:8090/manifest.json
```

`/healthz` returns `ok`. `/readyz` returns `200` with `"ready":true` when the configuration is valid,
the database answers and provider routing is sane; a `503` names the failing check. The
protected-resource document names the `/mcp` resource, the Auth0 issuer and the product scopes.

## 4. Call tools

- **stdio:** `npm run mcp:stdio` serves the same tools over stdin/stdout for local MCP clients.
- **HTTP:** point an MCP client such as MCP Inspector at `http://localhost:8090/mcp` with
  `Accept: application/json, text/event-stream`.
- **Flow harness:** `npm run flow` previews **and sends** a sample letter as `dev-user` through the
  tool handlers. Run it only with the dummy provider.

## Troubleshooting

- **`Invalid Host header` / `Invalid Origin header`:** add the host or origin to
  `LETTER_IRL_ALLOWED_HOSTS` / `LETTER_IRL_ALLOWED_ORIGINS`. See [docs/mcp-debugging.md](docs/mcp-debugging.md).
- **`Authentication is not configured on this server` (503):** either set the `LETTER_IRL_OAUTH_*`
  variables or, for local-only testing, `LETTER_IRL_REQUIRE_AUTH=false`.
- **Boot refused with a rule id:** look the rule up under **Boot validation rules** in
  [docs/deployment.md](docs/deployment.md).
- **Port already in use:** stop the other process, or set `LETTER_IRL_HTTP_PORT`.

## Related documentation

- [Auth0 setup](docs/auth0-setup.md) and [Auth0 tenant configuration](docs/auth0-tenant-configuration.md)
- [ChatGPT/Auth0 OAuth learnings](docs/learnings/chatgpt-auth0-oauth-learnings.md)
- [MCP tool APIs](docs/tool-apis.md)
- [Testing guide](docs/testing.md)
