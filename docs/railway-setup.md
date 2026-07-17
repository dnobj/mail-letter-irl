# Railway Setup Guide

Last updated: July 16, 2026

Letter IRL uses one Railway project with `production` and `development` environments. Environment isolation is achieved with per-environment variables and branch deployment settings, not separate Railway projects.

## Service Matrix

| Service | Source | Production branch | Development branch | Runtime |
| --- | --- | --- | --- | --- |
| `letter-irl-api` | backend repo | `master` | `dev` | HTTP API/MCP |
| `mail-letter-irl-website` | website repo | `main` | `dev` | Next standalone server |
| `letter-irl-maintenance` | backend repo | `master` | `dev` | hourly cron |
| `letter-irl-images` | Railway bucket | environment-owned | environment-owned | private S3-compatible storage |

Production API and website remain warm. Development API and website use Railway Serverless; cold health acceptance passed, while authenticated ChatGPT acceptance remains. The cron service is scheduled, not continuously running.

## API Settings

```text
Build command: npm run build
Pre-deploy command: npm run db:migrate:prod
Start command: npm start
Healthcheck path: /healthz
Production region: US East
Development region: US West (current; review separately before changing)
```

Important API variables:

```env
NODE_ENV=production
DATABASE_URL=<environment-specific Neon pooled URL>
TEMP_IMAGE_STORE=bucket
TEMP_IMAGE_BUCKET_NAME=<reference to bucket name>
TEMP_IMAGE_BUCKET_ENDPOINT=<reference to S3 endpoint>
TEMP_IMAGE_BUCKET_REGION=<reference to S3 region>
TEMP_IMAGE_BUCKET_ACCESS_KEY_ID=<reference to bucket access key>
TEMP_IMAGE_BUCKET_SECRET_ACCESS_KEY=<reference to bucket secret>
```

Use Railway variable references to the bucket service. Do not copy bucket credentials into Git, screenshots, logs, or documentation. The application also accepts Railway's standard `BUCKET`, `AWS_ENDPOINT_URL`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY` names.

## Maintenance Settings

Create `letter-irl-maintenance` from the backend repository in both environments:

```text
Build command: npm run build
Start command: npm run maintenance
Cron schedule: 0 * * * *
Restart policy: never/on failure only as supported for cron
Public domain: none
```

Reference the same backend variables used by the API, including the environment-specific database and bucket references. The command closes all clients and exits. Investigate any run that is still active near the next hour.

## Website Settings

```text
Build command: npm run build
Start command: npm start
Healthcheck path: /api/health
NEXT_TELEMETRY_DISABLED=1
```

The website package starts `.next/standalone/server.js`; do not override it with `next start`.

## Branch Deployment

For each service and environment, set the source branch explicitly:

- backend production: `master`
- backend development: `dev`
- website production: `main`
- website development: `dev`

Keep automatic deploys enabled. A feature branch must reach `dev` through a PR before it can deploy to development.

## Serverless Policy

- Production API: disabled
- Production website: disabled
- Development API: enabled July 16, 2026; `1.34s` cold health response accepted
- Development website: enabled July 16, 2026; `1.38s` cold health response accepted

After enabling, leave development idle for more than ten minutes. Confirm Railway reports both services asleep, then test MCP connect, image/widget rendering, login, and dashboard access. Disable Serverless if first-use recovery exceeds three seconds or any flow fails.

The public post-wake health, manifest, OAuth metadata, CORS, and homepage checks pass. Authenticated ChatGPT widget and image checks remain required before production promotion.

## Budget Controls

At the Railway workspace/project billing level:

- configure an email usage alert at `$7`;
- configure a hard usage limit at `$20`;
- review per-service memory after each runtime upgrade;
- expect idle spend to stay close to the Hobby plan minimum.

The July 2026 local API benchmark measured approximately `106.7 MB` RSS for compiled Node versus `219.3 MB` for the prior `tsx` runtime. Railway measurements can differ, but a sustained return toward the earlier 300+ MB API baseline should be investigated.

The `$7` email alert and `$20` hard limit were verified active on July 16, 2026.

Current development placement is API and website in Railway US West, maintenance in Railway US East, and Neon in AWS US East 1. This is documented configuration, not a recommendation; measure database latency and bucket-transfer behavior before consolidating regions.

## Verification

- Deploy status is successful in both environments.
- `/healthz` and `/api/health` return successfully.
- Migrations show `020_transactional_outbox.sql` as executed.
- Maintenance logs show one short run and clean process exit.
- An image remains retrievable after API restart for its documented 15 minutes.
- Development sleeps after ten idle minutes.
- Neon suspends after five database-idle minutes.

See [idle-cost-operations.md](idle-cost-operations.md) for observation and rollback procedures.
