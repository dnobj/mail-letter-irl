# Letter IRL Admin Operator Guide

**Last updated:** July 19, 2026

## Current availability

The legacy admin page and every public `/api/admin` route are disabled in all environments. Requests to
`/admin`, `/admin.html`, `/admin-panel.html`, `/admin/*`, `/api/admin`, and `/api/admin/*` return a
no-store `404`. Setting `ADMIN_ENABLED=true` makes public MCP/API startup fail closed; it does not enable
the old interface.

Do not open `admin-panel.html` directly, restore an `.env.admin` file, or place a production database URL
on a workstation. Slice 1 of [issue #162](https://github.com/dnobj/mail-letter-irl/issues/162) provides
database, configuration, contract, and audit foundations only. It does not provide the new local browser
server, session flow, or UI.

The approved implementation and permission gates are in
[admin-interface-modernization-plan.md](admin-interface-modernization-plan.md).

## Foundation in migration 022

`022_admin_audit.sql` follows #69's separate `021_jit_commerce_foundation.sql` and adds:

- a singleton development/production database marker;
- append-only `admin_audit_events` with bounded summaries;
- idempotent `admin_command_runs`;
- queued `admin_operations` for later environment-local provider workers;
- constraints, indexes, public privilege revocation, and an update/delete rejection trigger for audit
  events.

The migration does not insert an environment marker and does not create a role or credential. Application
rollback retains these tables and all evidence; database rollback is a later corrective migration, not a
drop of audit data.

## Access provisioning boundary

`npm run admin:provision-access` applies table grants only after both environment-specific login roles
already exist. It never creates a role, generates a password, or prints a credential. It requires:

- `--environment development|production`;
- `--config <path>` pointing to strict non-secret environment configuration;
- `--apply`;
- the schema-owner connection supplied only through the transient
  `LETTER_IRL_ADMIN_PROVISIONING_DATABASE_URL` process environment value;
- migrations `021_jit_commerce_foundation.sql` and `022_admin_audit.sql` already recorded;
- an empty or matching `admin_environment_marker`;
- exact, unprivileged login roles named for the selected environment.

Production also requires `--confirm-production-access`, but that flag is only an accident-prevention
control. It does not grant the owner approval required to provision a production role, create a vault
entry, or make a production connection. No production provisioning is authorized by this implementation
slice.

The non-secret JSON configuration belongs outside the repository at
`%LOCALAPPDATA%/LetterIRL/admin/<environment>.json`. Database and provider credentials belong in approved
vaults, not in this file, `.env`, command arguments, logs, or screenshots.

## Validation status

The durable slice-1 manual case is `ADMIN-FOUNDATION-022` in [manual-tests.md](manual-tests.md). It remains
awaiting execution by the browser-test task. The new authenticated local operator workflow will be
documented when slices 2 and 3 add the loopback server and read-only UI.
