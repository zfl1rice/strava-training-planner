# Strava training planner

npm workspace monorepo: Next.js web app, BullMQ worker, Prisma/Postgres,
and shared Zod schemas. Web and worker communicate through Redis/BullMQ.

## Strava connection setup

OAuth and token refresh are implemented. A real connection requires your own
[Strava API application](https://www.strava.com/settings/api). For local use,
set its Authorization Callback Domain to `localhost`.

Add these settings to **both** the root `.env` and `apps/web/.env.local`:

```dotenv
STRAVA_CLIENT_ID=your_client_id
STRAVA_CLIENT_SECRET=your_client_secret
STRAVA_REDIRECT_URI=http://localhost:3000/api/strava/callback
```

Preserve your existing database/Redis settings. Do not copy example database
credentials over an existing installation. Example files contain placeholders only.
Never prefix Strava secrets with `NEXT_PUBLIC_`.

Start Docker Desktop, then run from the repository root:

```powershell
docker compose up -d postgres redis
npm install
npm run db:generate
npm run db:deploy
npm run dev
```

Open http://localhost:3000, click **Connect Strava**, and approve activity access
(including private activities). The callback returns to the home page showing
your name and athlete ID. Tokens are stored in Postgres; the browser receives
an opaque, HttpOnly session cookie. Reconnecting reuses the athlete's existing
user record. Strava supplies no email, so new users have a nullable email.

If you use a different port or host, update `STRAVA_REDIRECT_URI` to match and
restart web. Always open the same hostname as that URL (do not mix localhost
and 127.0.0.1). Nonlocal callback URLs must use HTTPS; cookies are Secure on HTTPS.

The session lasts 30 days; sign in again afterward. OAuth state expires in ten
minutes and can be consumed only once. Denied access, missing permissions,
expired state, and failed exchanges show a message with a retry option.

## Verify OAuth and refresh

```powershell
npm run test:strava
```

This runs 13 integration tests with real Postgres persistence and simulated
Strava token responses. It creates and removes an isolated temporary database,
so the configured database role needs CREATE DATABASE permission (the local
Compose database user has it). It never contacts Strava or uses real OAuth
credentials. Real account authorization still requires the browser steps above.

To check your connected session from the browser's developer console:

```javascript
await fetch('/api/strava/refresh', { method: 'POST' }).then(r => r.json())
```

This returns connection metadata only. A token expiring within 60 seconds is
refreshed automatically; otherwise the saved token is reused. Both returned
tokens are saved together, with a Postgres row lock preventing competing
refreshes. A rejected refresh prompts reconnection; transient failures retain
the stored credentials and return 503 so the caller can retry.

The future sync worker can call `getValidStravaAccessToken` from `@pkg/db`,
passing `refreshStravaTokens` from the server-only `@pkg/shared/strava` entry point.
The OAuth API implementation follows
[Strava's authentication documentation](https://developers.strava.com/docs/authentication/).

## Sync activities

After connecting Strava, click **Sync Activities** on the home page. Keep both
web and worker running with `npm run dev`. Restart that command after pulling
worker changes (the worker development script does not watch files).

For an existing checkout, apply the new migration before starting:

```powershell
npm run db:generate
npm run db:deploy
npm run dev
```

The button requests `POST /api/strava/sync`. The endpoint derives the user from
the session, records a sync in Postgres, and enqueues only `{ jobRunId }`.
Concurrent clicks reuse the active sync. The worker refreshes tokens when
needed, fetches pages of activities, and upserts by unique Strava activity ID.
Web and worker remain separate applications with no imports between them.

Each sync covers the **last 90 days**, with its time window fixed at enqueue
time. Repeating a sync updates those activities without creating duplicates.
It does not remove activities deleted on Strava or fetch older history.
Duration uses Strava moving time; distance/elevation are rounded to whole meters
to match the existing database schema. The dashboard shows the most recent 30
stored activities and dates in UTC.

Progress and the last successful sync time come from Postgres through
`GET /api/strava/sync`. The page polls while a job is queued or running. Failed
syncs keep the previous success timestamp and any pages already persisted.
Retrying safely replays the fixed window. Transient failures get up to five
total attempts with exponential backoff; 429 responses respect Retry-After or
Strava's quarter-hour/daily reset. Access rejections prompt reconnection.

```powershell
npm run test:sync
```

Sync integration tests use real Redis/BullMQ and an isolated temporary Postgres
database with simulated Strava responses. A random Redis prefix isolates the
test jobs from your running worker. They cover pagination, duplicate clicks,
upserts, empty history, refresh, transient/permanent failures, rate limits,
activity validation, and session isolation. Keep Docker Postgres and Redis
running. Optional `BULLMQ_PREFIX` must match in web and worker if you configure it;
normal local use needs no prefix setting.

API behavior follows the [Strava activity reference](https://developers.strava.com/docs/reference/#api-Activities-getLoggedInAthleteActivities)
and [rate-limit documentation](https://developers.strava.com/docs/rate-limits/).

## Typed PingJob

Run commands from the repository root (the directory containing this file).

1. Install dependencies: `npm install`.
2. Configure `REDIS_URL=redis://localhost:6379` in the root `.env` and
   `apps/web/.env.local`. Both apps must use the same Redis URL, including database.
   Preserve the existing database settings.
3. Start Docker Desktop, then run `docker compose up -d redis`.
4. Run `npm run dev` to build the shared packages and start web and worker.
5. In another terminal, run `npm run test:ping`.

The smoke test sends an HTTP request, waits for the worker result in BullMQ,
and checks invalid payload / unknown job rejection. It removes its own test jobs.
Set `WEB_URL` if web runs somewhere other than http://localhost:3000.

Manual enqueue in PowerShell:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/enqueue/ping -ContentType application/json -Body '{"userId":1}'
```

The response includes a job ID; the worker logs processing. An empty request
body retains the development default of user ID 1. Ping does not require a
database user. This is a development diagnostic endpoint.

## Checks and production processes

- `npm run typecheck`: builds packages, then checks all four workspaces.
- `npm run build`: builds shared/database packages before worker and web.
- `npm run start --workspace @app/web`: starts the built web app.
- `npm run start --workspace @app/worker`: starts the compiled worker.
- `npm run dev:web` or `npm run dev:worker`: starts one app after building packages.

The worker loads the root `.env`; existing process environment variables take
precedence. Next.js uses its app-local environment files. For deployment, provide
environment variables to each separate application.

Shared packages export compiled JavaScript. After editing a shared package,
restart `npm run dev` or run its `build:watch` script in another terminal.

See [the MVP checklist](docs/mvp-status.md) for completed and pending milestones.
