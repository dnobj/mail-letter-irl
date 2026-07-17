# Letter IRL Project Status

Last updated: July 16, 2026

Current phase: production MVP and OpenAI app submission preparation, with development-first releases.

## Product

Letter IRL lets an authenticated user create, preview, and send physical US letters and postcards from ChatGPT or the Letter IRL website. The product includes prepaid letter packs, address validation, image generation/upload, preview widgets, return-address storage, order history, and provider status retrieval.

The ChatGPT integration is an MCP server with OpenAI Apps SDK widget resources. Existing public MCP tool names and schemas are treated as stable compatibility contracts.

## Environments

| Layer | Production | Development |
| --- | --- | --- |
| Backend | `master` -> Railway production | `dev` -> Railway development |
| Website | `main` -> Railway production | `dev` -> Railway development |
| Database | Neon production branch | Neon `dev` branch |
| Payments | Stripe live | Stripe test |
| Mail provider | PostGrid live | PostGrid test/dummy |
| Auth | production Auth0 tenant | development Auth0 tenant |

Railway uses one project with separate production and development environments. Neon uses one project with isolated database branches. See [infrastructure.md](infrastructure.md).

## Current Architecture

- Backend: strict ESM TypeScript compiled with `tsc`, then run with Node 22.
- Website: Next.js standalone production server.
- Database: Neon PostgreSQL through pooled connection strings and a five-client application pool.
- Mail dispatch: transactional `letter_jobs` outbox with immediate provider submission.
- Recovery: one-shot hourly Railway maintenance cron.
- Temporary generated images: private Railway S3-compatible bucket with a 15-minute TTL.
- Production availability: API and website stay warm.
- Development cost control: API and website use Railway Serverless; sleep/wake acceptance testing is in progress.

The API process starts no queue polling, status-sync, credit-cleanup, or image-cleanup timers. `pg-boss` has been removed from the deployed architecture.

## Safety Properties

- Draft consumption, order creation, credit deduction, and outbox insertion commit atomically.
- A draft can produce at most one Letter IRL order.
- A letter has one outbox row and a stable provider idempotency key.
- Immediate and maintenance retries reuse the same PostGrid `Idempotency-Key`.
- Cloud image URLs survive API restarts for their documented lifetime.
- Production and development database/payment/provider settings remain isolated.
- MCP request payloads containing addresses or letter text are not written to routine logs.

## Verification Status

For the idle-cost release as of July 16, 2026:

- strict backend TypeScript: passing;
- backend source/test lint: passing;
- backend unit suite: 651 tests passing after the final dependency and configuration updates;
- backend production dependency audit: zero known vulnerabilities;
- website lint and production build: passing;
- website dependency audit: zero known vulnerabilities;
- local API RSS: approximately `106.7 MB` compiled versus `219.3 MB` under `tsx`.

Development rollout status:

- migration `020_transactional_outbox.sql` is applied;
- the API, website, OAuth metadata, manifest, unauthenticated MCP challenge, and ChatGPT CORS preflight respond correctly;
- the hourly maintenance command has completed multiple short runs and closed its database pool cleanly;
- the development API and maintenance service use the pooled Neon development hostname;
- Railway has a `$7` email alert and `$20` hard limit, and Neon has a `$10` email-only spending limit;
- both development Railway web services have Serverless enabled;
- the Neon development compute has been observed suspended with its `0.25-0.5 CU` and five-minute scale-to-zero policy active.

Image restart persistence, Serverless wake latency, the post-wake ChatGPT widget/image flows, and the seven-day Neon idle observation must still pass before production promotion. Production remains on the previous release with a temporary ten-minute polling safeguard until that acceptance gate is complete. Track the remaining work in [manual-tests.md](manual-tests.md) and [idle-cost-operations.md](idle-cost-operations.md).

## Release Path

1. Feature branches target `dev`.
2. Railway deploys development automatically.
3. Automated and documented manual tests run against development.
4. Backend `dev` is promoted to `master`; website `dev` is promoted to `main` only after acceptance.

## Key Documents

- [Infrastructure](infrastructure.md)
- [Deployment](deployment.md)
- [Railway Setup](railway-setup.md)
- [Letter Send Flow](letter-send-flow.md)
- [Manual Tests](manual-tests.md)
- [Idle-Cost Operations](idle-cost-operations.md)
- [OpenAI Submission Checklist](app-submission/owner-checklist.md)
