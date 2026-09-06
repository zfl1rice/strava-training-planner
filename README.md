# Strava training planner

npm workspace monorepo: Next.js web app, BullMQ worker, Prisma/Postgres,
and shared Zod schemas. Web and worker communicate through Redis/BullMQ.

The [PlanningContext checkpoint](docs/planning-context.md) adds athlete profiles,
race demands, evidence history, availability, and restrictions for future planning.
See the [seeded context example](docs/planning-context.example.json). The sidebar now
provides [Profile, Goals, and Availability screens](docs/planning-settings.md).
These save planning inputs; the existing v1 planner does not yet apply them.
AI calls are not implemented.

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

The sync worker calls `getValidStravaAccessToken` from `@pkg/db`,
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

### Automatic sync recovery

The worker checks unfinished Postgres sync records at startup and every 30 seconds.
Missing BullMQ jobs are recreated using the original job ID and time window.
Existing waiting, active, paused, and delayed jobs are left alone. Failed, cancelled,
and successful database records are never automatically restarted.

`POST /api/strava/sync` returns 202 once the request is saved in Postgres, even if
Redis is temporarily unavailable (`recoveryPending: true`). The dashboard continues
polling and the worker enqueues it when Redis returns. If Postgres cannot save the
request, the endpoint still returns an error. This also handles lost enqueue
acknowledgements without incorrectly marking a successfully queued job failed.

Postgres stores execution attempts, retry time, and a two-minute lease renewed
between bounded pages. Missing running jobs wait for lease expiry, then recover on
the next scan. An attempt number guards page/final-status writes against an old
worker resuming after replacement. Interrupted starts count toward the five-attempt
limit; recreated jobs cannot reset that budget or bypass recorded rate-limit waits.
Terminal BullMQ jobs with unfinished, unleased DB records become failed rather than
being blindly replayed. Retry exhaustion requires an explicit new sync request.

Stop old worker processes, then run `npm run db:generate` and `npm run db:deploy`
before restarting `npm run dev` for this upgrade. Counters/delays become durable
with this version; attempts lost from Redis before the upgrade cannot be reconstructed.
Recovery needs a running worker plus available Postgres/Redis. It does not require
another service. Pending recovery and retry records block plan generation, as do
normal queued/running syncs.

```powershell
npm run test:sync
```

Sync integration tests use real Redis/BullMQ and an isolated temporary Postgres
database with simulated Strava responses. A random Redis prefix isolates the
test jobs from your running worker. They cover pagination, duplicate clicks,
upserts, empty history, refresh, transient/permanent failures, rate limits,
activity validation, and session isolation. Keep Docker Postgres and Redis
running. Recovery tests also cover missing jobs, overlapping scans, live/expired
leases, replayed pages, lost acknowledgements, startup Redis outages, terminal states,
persisted retry delays, and attempt exhaustion.
Optional `BULLMQ_PREFIX` must match in web and worker if you configure it;
normal local use needs no prefix setting.

API behavior follows the [Strava activity reference](https://developers.strava.com/docs/reference/#api-Activities-getLoggedInAthleteActivities)
and [rate-limit documentation](https://developers.strava.com/docs/rate-limits/).

## Training calendar

The dashboard opens with a Monday–Sunday month calendar. Green entries are completed
activities from Strava; blue entries are saved planned workouts. Cards show a short
title and total duration. Click a card for the workout steps or activity details;
Escape or the close button dismisses the dialog. Completed activities link to Strava.

Use the month picker, arrows, or Today button to navigate. The left column shows
separate completed/planned weekly totals. Dates use UTC, consistent with summaries
and saved plans. On phones, scroll horizontally inside the calendar.

The session-protected `GET /api/calendar?month=YYYY-MM` loads all saved activities
and weekly plans in the complete weeks touching that month, including historical
plans. It does not use the sync dashboard's 30-activity limit. Sync completion and
successful generation refresh the visible calendar. No new Strava API calls or
database migration are required for this view.

Completed and planned entries are deliberately separate: an activity does not
automatically mark a planned workout as fulfilled. Open **Plan settings & weekly
goals** below the calendar to save goals and generate next week's plan. Open
**Training summaries** for the detailed volume table.

Run `npm run test:calendar` for calendar ranges, account isolation, full activity
loading, and historical plan coverage against an isolated database.

## Weekly training summaries

The dashboard shows the current week and the preceding three calendar weeks.
Weeks start Monday at 00:00 UTC and end at the next Monday (exclusive). An
activity belongs to the week in which it started; its duration is not split
across midnight. The current week is marked as incomplete, and future-dated
activities are excluded.

Run, bike, and swim each show moving minutes and distance. Run/bike distances
are displayed in kilometers; swim distances in meters. Other activities have
their own time column and are included in total weekly time. Missing distances
are marked as unavailable or partial instead of appearing as a measured zero.

The recent average covers the previous three complete weeks, including empty
weeks as zero, and excludes the partial current week. These metrics reflect
stored activities, so incomplete syncs can produce incomplete totals.

Summaries read **all** activities in the window from Postgres, independently of
the sync endpoint's 30-row activity preview. They update through the existing authenticated
sync-status endpoint whenever the dashboard polls or the page is reloaded.
No migration or new Strava requests are needed for summaries.

```powershell
npm run test:training
```

The isolated-database tests cover UTC/Monday and year boundaries, offset dates,
empty weeks, exact time/distance totals, missing distances, incomplete-week
averages, user isolation, and histories larger than 30 activities.

## Template-based weekly planner

Click **Generate next week's plan** on the dashboard after syncing. Generation
uses the three completed weeks from your stored summaries and saves a structured
Monday–Sunday UTC schedule in Postgres. It makes no Strava or LLM requests.
Restart `npm run dev` after updating the project. For another checkout, run
`npm run db:generate` and `npm run db:deploy` before starting.

Under **Weekly goal minutes**, enter run, bike, and swim time in five-minute
increments, click **Save goals**, then generate or regenerate next week's plan.
For example, run 90 + bike 150 + swim 60 requests a 300-minute week.
Blank fields use automatic targets; zero skips that sport. **Use automatic targets**
clears the fields; click **Save goals** to persist that choice. Goals are saved per
user in Postgres and survive reloads. Changing goals does not change saved plans
until you regenerate.

Custom goals override history for the selected sports. With any custom goal,
blank sports without recorded history receive zero minutes. With all fields
automatic and no history, the optional starter schedule below still applies.
The current templates can schedule up to 105 run, 180 bike, and 75 swim minutes
per week. Higher goals are saved, but the plan explicitly shows the unscheduled
minutes; goals below a sport's shortest workout also remain unscheduled.

The rules are deterministic:

- Average each sport's minutes across three completed weeks, including empty
  weeks as zero. Current-week and other-sport activity do not raise the budget.
- Round budgets down to five-minute blocks; do not automatically increase volume.
- Use up to two workouts per sport. For two sessions, allocate roughly 40% to
  the shorter session and the remainder to the longer session, subject to limits.
- Use one session if the budget cannot fit two; leave the day as rest if even
  the shortest template cannot fit. Surplus minutes above template caps stay unused.
- Monday is rest. Run slots are Tuesday/Sunday, swim Wednesday/Friday, and bike
  Thursday/Saturday. There is at most one workout per day and all templates are easy.
- Each workout has warm-up, main-session, and cool-down instructions whose
  durations add up to the session duration. Plans are validated before saving.

| Template | Duration range |
| --- | --- |
| Easy run | 10–45 min |
| Longer easy run | 15–60 min |
| Easy endurance ride | 15–60 min |
| Longer easy ride | 20–120 min |
| Easy technique swim | 10–30 min |
| Easy steady swim | 10–45 min |

Sparse history is flagged. With automatic goals, if no completed-week swim/bike/run volume exists,
the app offers a clearly labeled **optional starter schedule**: a 10-minute
run, 20-minute bike, and 10-minute swim. This is a generic assumption, not an
estimate of fitness. With some recorded volume, missing sports are not added
automatically. Review the displayed assumptions and skip optional activities
that do not suit your experience.

`POST /api/planner` generates the next week for the signed-in user and upserts
one record per user/week using saved goals. `GET /api/planner` loads those goals
and the saved current and next week. `PATCH /api/planner` saves a strict body such
as `{ "RUN": 90, "BIKE": 150, "SWIM": 60 }` (each value may be `null` for automatic).
Writes require the signed-in session and matching origin. Generation returns 409
while sync is pending/running (including delayed retries and recovery).
Sync creation and plan generation use the same per-user Postgres transaction lock.
If generation starts first, a concurrent sync request waits until the plan commits;
if sync creation starts first, generation sees the committed sync and rejects.
The active-sync check, history/goal reads, generation, and save all stay within the
locked transaction. Different users do not share a lock. Lock waits are bounded to
five seconds and these transactions to ten seconds; contention failures roll back
and return a retryable 503. No transaction stays open for Strava network calls.
The saved plan remains
unchanged after later syncs until you explicitly regenerate it; regenerating
replaces that week's plan. Current-week plans remain available after Monday.

```powershell
npm run test:planner
```

Planner tests cover deterministic selection, budget and template limits,
sparse/empty history, scheduling, persistence, regeneration, concurrent requests,
week rollover, session isolation, goal persistence/validation, custom targets,
and compatibility with older plans. Plans are stored as validated, versioned
JSON in `WeeklyPlan`; shared templates and logic live in `packages/shared/src/planner.ts`.

LLM integration, race periodization, calendar integration, template editing,
and advanced training-load modeling remain deferred.

## Typed PingJob

Run commands from the repository root (the directory containing this file).

1. Install dependencies: `npm install`.
2. Configure `REDIS_URL=redis://localhost:6379` in the root `.env` and
   `apps/web/.env.local`. Both apps must use the same Redis URL, including database.
   Preserve the existing database settings.
3. Start Docker Desktop, then run `docker compose up -d redis`.
4. Temporarily enable diagnostics in the terminal that starts web, then start both apps:

   ```powershell
   $env:ENABLE_PING_DIAGNOSTICS = "true"
   npm run dev
   ```

5. In another terminal, run `npm run test:ping`.

Ping is disabled by default in development and production. Only the exact
server environment value `ENABLE_PING_DIAGNOSTICS=true` enables it. Otherwise it
returns 404 before parsing the request or connecting to Redis. Setting the flag
only in the smoke-test terminal does not enable the web endpoint.

After testing, stop the processes, run `Remove-Item Env:ENABLE_PING_DIAGNOSTICS`
in the launch terminal, and restart normally. If you put the flag in
`apps/web/.env.local`, remove it or set it to `false` before restarting instead.
The enabled endpoint is unauthenticated; enable it only for controlled testing.

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
- `npm run lint`: runs the web application's ESLint rules. Worker and packages
  currently rely on TypeScript and tests; there are no placeholder lint checks.
- `npm run test:ping-route`: tests the diagnostic flag and payload validation
  without running Postgres, Redis, or the worker.
- `npm run test:health`: checks dependency health and safe failure responses using
  an isolated database and the configured Redis service.
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
See [the product vision](docs/product-vision.md) for scope and future direction.
See [the detailed design document](docs/design.md) for current data flows, planning
rules, failure behavior, proposed next steps, and a decision register for review.
See [the code review guide](docs/code-review.md) for findings, a file-by-file map,
and a suggested order for your own review. Review `src` files; `dist` is generated.

The `/health` page checks Postgres and Redis directly. Individual probes are at
`/api/postgres_health` and `/api/redis_health`; failures return 503 with generic
messages. These are dependency checks, not proof that the worker is processing jobs.
Local Compose ports bind to `127.0.0.1`; existing containers adopt that change the
next time you run `docker compose up -d`. Use `.env.example` as the canonical root
example; the obsolete `.env_example` file has been removed.
