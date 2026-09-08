# Deployment preparation

Prepared target: Vercel web, hosted PostgreSQL, hosted Redis, and a separate Node.js worker on your machine or server. No verified public demo URL is recorded in this repository. Free service tiers are subject to their current limits; this is not a promise of free hosting or free OpenAI usage.

Repository: [zfl1rice/strava-training-planner](https://github.com/zfl1rice/strava-training-planner). Import this repository when configuring the web deployment. Follow the [current architecture](architecture.md); older design/checkpoint notes are not evidence that services have been deployed.

## Web on Vercel

Import the Git repository as a Next.js project. Set Root Directory to `apps/web` (relative to the Git root), and enable **Include source files outside of the Root Directory in the Build Step** so workspace packages are available. This follows [Vercel's monorepo guidance](https://vercel.com/docs/monorepos/monorepo-faq).

Use these project commands, which start inside `apps/web`:

| Setting | Command |
| --- | --- |
| Install | `cd ../.. && npm ci` |
| Build | `cd ../.. && npm run build:web` |
| Framework | Next.js |
| Output directory | Framework default (`.next`) |

`build:web` generates Prisma, builds shared/db packages, then builds Next.js. `next.config.ts` traces dependencies from the monorepo root. No migrations run during a web build. The existing Google font imports require outbound access at build time.

Set server-side environment variables: `DATABASE_URL`, `REDIS_URL`, `BULLMQ_PREFIX` if used, `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, and `STRAVA_REDIRECT_URI`. Do not set OpenAI secrets in Vercel: model calls belong to the worker. Do not create any `NEXT_PUBLIC_` secret.

Choose a stable production hostname. Set `STRAVA_REDIRECT_URI=https://your-host/api/strava/callback` and register that hostname with the Strava API app. The same origin is used for mutation checks, and HTTPS enables Secure cookies. Dynamic preview URLs need their own explicitly configured callback/origin; they should not reuse production credentials/database by accident.

## Postgres and Redis

Web and worker must use the same database and Redis namespace. Use TLS as required by the provider. The current database adapter uses `DATABASE_URL`; use a migration-capable direct connection for schema deployment if your provider requires one. Keep it in the command environment rather than source files.

Redis must expose the TCP protocol supported by ioredis/BullMQ, including blocking operations. An HTTP-only key-value API is insufficient. Configure `maxmemory-policy=noeviction` and choose limits suitable for polling/queue connections. BullMQ documents both [connection requirements](https://docs.bullmq.io/guide/connections) and [production Redis settings](https://docs.bullmq.io/guide/going-to-production).

Before switching the worker/web to the new release, deploy the additive migrations from a trusted terminal configured for the intended database:

```powershell
npm ci
npm run db:generate
npm run db:deploy
```

Review the target database before running migrations. Do not run `db:reset` or `db:recreate` against hosted data. Hosted service sleep, connection limits, and quota exhaustion can delay work; no production uptime claim is made.

## Worker on your machine or server

Set hosted infrastructure credentials in its environment (or local ignored files). Keep `OPENAI_API_KEY`, `PLANNER_PROVIDER=openai`, and model options on this machine. Worker `.env.local` overrides root file defaults, but process environment variables take precedence over both files.

```powershell
npm ci
npm run build:worker
npm run start --workspace @app/worker
```

Keep the process and computer running. Only outbound network access is needed: do not expose a home Redis/Postgres server or forward an inbound worker port. On restart, recovery scans pending plan/review/sync records. Leases fence stale executions; provider calls can still be repeated after a crash before a response was persisted, so API execution is not guaranteed exactly once.

## First public deployment checklist

1. Provision hosted Postgres and TCP Redis; verify their current limits and TLS requirements.
2. Apply migrations and configure/start the worker against those services.
3. Import/configure Vercel with the settings above, then deploy web explicitly.
4. Register the stable Strava callback hostname and finish the authenticated smoke checklist.
5. Verify `/demo` without a session; it must display only synthetic data.
6. Verify the URL from a signed-out browser on another device, then put the `/demo` URL in the README opening links, GitHub About website and portfolio. Keep development and production queues/databases separate.

Before describing the full application as deployed, separately verify OAuth, sync, generation and review against the hosted database/Redis and the running worker. A static `/demo` screenshot alone proves none of those external connections. Record the verified URL and setup, rather than claiming a particular worker host that has not been used.

The public read-only demo needs no athlete data. Full authenticated use currently relies on Strava sessions; advanced account administration, abuse prevention, and unrestricted multi-user operation remain outside this personal-project checkpoint. A public recruiter demo is a smaller commitment than offering the authenticated app as an unrestricted service.
