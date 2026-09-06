# Code review and source guide

## September 6 PlanningContext foundation

Start with the [checkpoint and new-file review map](planning-context.md#review-map)
and [seeded output](planning-context.example.json). This pass adds three domain tables,
shared planning schemas, local-date context construction, and protected v1 workout
metadata. The detailed September 5 file map below remains the guide to existing code.
No AI calls were added. The subsequent [planning settings UI review map](planning-settings.md#file-review-map)
covers the new sidebar, forms, settings API, and storage edits. Start that review
with ownership checks, preservation of noneditable profile data, and stale-edit handling.

Reviewed September 4, 2026; automatic recovery, sync/plan coordination, and opt-in
Ping diagnostics implemented September 5. See [the product vision](product-vision.md)
for the expanded MVP scope provided after this review.
This covers the working tree, including the previously
uncommitted summaries, planner, and weekly goals. It is a source/correctness review,
not a penetration test or a dependency vulnerability audit. No architecture rewrite,
new service, training algorithm expansion, or AI integration was introduced.

## September 5 readability pass

Reviewed the current application source, contracts, storage, worker lifecycle,
configuration, and regression coverage. The working tree already contained the
MVP features and prior review changes; the changes in this pass are listed below.
Use the [complete file map](#complete-file-map) to navigate and leave CR notes.

| Finding | Change in this pass |
| --- | --- |
| A worker-only Redis wrapper forwarded configuration at its sole call site. | Removed `apps/worker/src/redis.ts`; the worker entry point now shows its connection options directly. |
| Queue setup repeated global casts and generic type arguments. | One cache declaration retains two distinct typed producers; constructor types come from the existing queue aliases. No generic factory was introduced. |
| Sync storage/recovery used ambiguous `run`, `active`, `owned`, and `saved` names. | Named sync records, active syncs, lease updates, completion writes, and saved activities explicitly; expanded the ownership guards. |
| Retry handling used a four-level nested conditional expression. | Explicit branches describe provider rejection, rate limits, known permanent failures, and transient failures. |
| An exhausted HTTP 429 failure said it was waiting to retry. | Terminal failures now ask the user to try later; a new regression verifies FAILED status, the five-start limit, and no retry date. |
| Plan storage compressed week lookup and transaction checks into long expressions. | Named current/next week boundaries and expanded queries, guard clauses, and serialization. Removed one redundant validation immediately after the generator's validation; DB reads still validate snapshots. |
| Planner booleans and UI helpers hid intent. | Named custom/starter modes, previous hard day, budget conditions, planner state, goal fields, date/minute formatting, and generation explicitly. Reused the shared sport list. |
| Dense form handling and table markup were awkward to annotate. | Expanded validation, request options, error/finally blocks, and sport table cells locally. Components remain in their existing files. |
| Root TypeScript configuration retained commented scaffold options. | Removed inactive tutorial comments while preserving every enabled compiler option. |

Validation: 84 tests passed (28 sync/recovery, 27 planner, 13 OAuth, 9 summaries,
3 health, 4 Ping route), all workspace typechecks, web ESLint, and the production
build. Compiled worker startup and the HTTP → Redis → worker Ping smoke also passed.
Integration suites use isolated databases/Redis prefixes and simulated Strava responses.
No browser click-through was performed for this pass; use the manual checks below.

One initial sync-suite run timed out in the recovered-final-attempt test; the next
two runs passed, including the final 28-test run. Its cause is not established.
Do not treat that intermittent timeout as fixed by the readability changes.

For tomorrow's CRs, write notes in the file-map column or use
`file:line — observation — suggested change`. Review the source files; `dist`
contains generated output and can retain obsolete files until a clean build.

## Start your review here

Spend your first pass on these files, in this order. Read each implementation
beside its tests; tests describe supported behavior but do not prove the training
choices are appropriate for an athlete.

| Priority | Source | What to question | Tests |
| --- | --- | --- | --- |
| 1: training behavior | [shared planner](../packages/shared/src/planner.ts) | Three-week average, empty weeks, starter fallback, custom goals, session minima/maxima, fixed days, roughly 40/60 split. These are MVP policy choices, not fitness estimates. | [planner tests](../tests/planner.test.mjs) |
| 2: job consistency | [sync endpoint](../apps/web/src/app/api/strava/sync/route.ts), [activity storage](../packages/db/src/activities.ts), [worker processor](../apps/worker/src/processor.ts) | What happens between the DB write and queue write? Can a retry or crash leave a status wrong? Are page upserts and ownership checks atomic? | [sync tests](../tests/activity-sync.test.mjs) |
| 3: credentials and identity | [auth helpers](../apps/web/src/lib/strava-auth.ts), [OAuth callback](../apps/web/src/app/api/strava/callback/route.ts), [Strava storage](../packages/db/src/strava.ts) | State replay, session expiry/rotation, athlete identity, concurrent token refresh, and keeping credentials out of responses. | [OAuth tests](../tests/strava-oauth.test.mjs) |
| 4: saved plan semantics | [planner storage](../packages/db/src/planner.ts), [planner endpoint](../apps/web/src/app/api/planner/route.ts) | Which user/week is changed? When do goals take effect? What happens if sync starts during generation? | [planner tests](../tests/planner.test.mjs) |
| 5: totals and user expectations | [summary calculation](../packages/shared/src/training.ts), [weekly planner UI](../apps/web/src/app/weekly-planner.tsx) | UTC versus local weeks, moving versus elapsed time, missing history, unsaved goals, and requested versus scheduled minutes. | [summary tests](../tests/training-summary.test.mjs), manual UI checks below |

## Findings fixed in this review

| Finding | Impact | Change |
| --- | --- | --- |
| Public health endpoints returned raw database/Redis errors. | Internal connection details could reach a browser when a dependency failed. | Generic failure responses with HTTP 503 and `Cache-Control: no-store`; removed `any` catches. |
| `/health` fetched nonexistent `/api/health` at hardcoded port 3000. | The page failed and could not work reliably on another port or deployment. | Page directly invokes the same probes as the individual endpoints; no self-HTTP request. |
| Redis probe closed its connection only after success and used default reconnect behavior. | Failed probes could retain connections or keep trying instead of responding promptly. | Explicit connect/command timeouts, no retry loop, and unconditional disconnect in `finally`. |
| Database health counted every user. | An availability check did unnecessary work as the table grew. | Query one user ID; an empty table still succeeds. |
| Local Compose published Postgres and unauthenticated Redis on all host interfaces. | Depending on firewall/network setup, other machines could reach local development services. | Bind both ports to `127.0.0.1`. Existing containers require `docker compose up -d` to adopt this. |
| The tracked `.env_example` duplicated the canonical example and contained a password matching the local database. | Confusing setup and an example value being used as a real local credential. | Removed the obsolete file; `.env.example` remains. Strava entries in the removed file were placeholders. Deletion does not remove Git history or rotate the local password. Use separate credentials for any nonlocal deployment. |
| An unused web Redis module opened a connection at import time. | Dead code offered a competing connection path with no lifecycle policy. | Removed `apps/web/src/lib/redis.ts`; queue clients still live in `lib/queue.ts`. |
| Shared barrel retained `shared = "ok"`. | An unused import smoke-test artifact looked like a supported API. | Removed it after checking references. |
| Planner used five-position tuples and a magic `/ 180` conversion. | Schedule fields and units were unnecessarily hard to follow. | Named shorter/longer slots, explicit seconds-to-minutes and week-count calculation, clearer template and rounding helper names. |
| Plan validation accepted workouts moved to another sport's day if totals still matched. | A malformed snapshot could contradict the documented schedule. | Validate template ID against the same version-1 schedule used for generation; regression case swaps Tuesday/Wednesday workouts. |
| Some domain variables obscured meaning. | `run` was ambiguous beside the RUN sport; `count`, `active`, and `dirty` needed context. | Renamed to `syncRun`, `processedActivityCount`, `activeSync`/`syncActive`, and `hasUnsavedGoals`; also clarified storage serialization, form conversion, and activity mapping names. |
| A stalled browser polling request had no timeout. | One unanswered request could stop all subsequent progress refreshes. | Combine unmount cancellation with a ten-second request timeout; the existing polling loop can retry. |
| Prisma adapter was allocated before checking the hot-reload client cache. | Re-evaluating the module constructed an unnecessary adapter even when reusing the client. | Allocate the adapter only when creating the Prisma client. |
| Prisma config used CommonJS in a package declared as ESM. | It depended on CLI loader behavior and confused the module conventions. | Use ESM imports/export and an `import.meta.url`-relative environment path; migrations verified through the test harness. |
| Root lint included fake-success scripts and a workspace without a lint script. | The command could fail despite passing real checks or imply broader lint coverage than existed. | Root lint explicitly runs web ESLint; removed echo-only scripts. All workspaces still have typechecks. |

## Remaining findings and limitations

Resolved follow-ups are marked explicitly; the other items remain outstanding.
Failure scenarios below are identified from control flow unless a test is cited.

1. **Resolved by decision 3: Ping diagnostics require explicit opt-in.**
   [Ping route](../apps/web/src/app/api/enqueue/ping/route.ts) returns 404 by default
   before reading the body or creating a Redis client. Only the server environment
   value `ENABLE_PING_DIAGNOSTICS=true` enables it, in development or production.
   The enabled route remains unauthenticated for standalone smoke tests; disable it
   and restart web when testing ends. Four route tests and the production HTTP-to-worker
   smoke test cover the switch. Public health probes still have no rate limiting
   and remain a consideration for public deployment.

2. **Resolved by decision 1: automatically reconcile missing sync jobs.**
   [Recovery loop](../apps/worker/src/recovery.ts) checks unfinished DB records on
   startup and every 30 seconds, reconstructing missing queue jobs with deterministic
   IDs. Existing active/waiting/paused/delayed jobs remain unchanged. The endpoint
   leaves committed requests pending on enqueue failure, including lost acknowledgements.
   Postgres stores an execution counter, retry time, and renewable two-minute lease;
   attempt numbers fence stale writes after a crashed execution is replaced. Redis
   loss cannot reset newly persisted attempt budgets or retry delays. Terminal DB
   records are never restarted; terminal BullMQ states are reconciled conservatively
   once no live DB lease remains. Tests cover missing/repeatedly lost jobs, concurrent
   scans, startup Redis failure, old-worker writes, live leases, and retry exhaustion.
   This is eventual recovery, not an atomic transaction across DB and Redis. Both
   services and the worker must become available; retries recorded before this
   upgrade cannot be recovered if Redis already lost them.

3. **Resolved by decision 2: sync and plan generation must not overlap.**
   [generateAndSaveWeeklyPlan](../packages/db/src/planner.ts) and sync creation both
   acquire [the per-user transaction lock](../packages/db/src/training-lock.ts).
   The generator holds it from the active-sync check through all reads and the saved
   plan commit. Read Committed isolation ensures a waiter sees a sync committed by
   the preceding lock holder. Existing pending/running records, including delayed
   retries and recovery, return 409; otherwise a new sync waits for generation to
   finish. Terminal jobs cannot resume writes because decision 1 fences them.
   Locks release on commit/rollback; waits are limited to five seconds, transactions
   to ten. No Strava calls occur under this lock, and different users have independent
   keys. Real Postgres tests force both orderings, unrelated-user work, and failed
   saves; they verify exclusion without relying on arbitrary sleeps or mocked locks.
   Failed prior syncs may still leave partial stored history, which existing plan
   assumptions disclose; this decision does not roll back completed activity pages.

4. **Medium: saved plans depend on the current version-1 template definitions.**
   [validateWeeklyPlan](../packages/shared/src/planner.ts) runs on DB reads and
   resolves template IDs against code. Removing a template, reducing its maximum,
   or changing its day can invalidate existing snapshots. Keep version 1 stable
   and introduce a version-aware reader when changing those policies. This review
   does not change template durations or supported generated schedules.

5. **Training data has deliberate limits.**
   [Worker ingestion](../apps/worker/src/processor.ts) fetches 90 days and upserts;
   it does not reconcile activities deleted on Strava. [Sport mapping](../packages/db/src/activities.ts)
   counts e-bike and handcycle activities as BIKE. [Summaries](../packages/shared/src/training.ts)
   use moving time and UTC start dates, zero-fill missing weeks, and include OTHER
   in the overall total, while the planner excludes OTHER. Review these product
   decisions before treating volume as fitness. None of them estimates intensity
   or physiological readiness.

6. **Some UI state can become stale.**
   The dashboard polls only while it knows a sync is active. Another tab's goal
   edits or jobs, and crossing Monday while leaving the page open, require reload
   to reliably refresh all planner state. Server generation still calculates the
   week itself. Automated tests call route handlers and storage; they do not click
   buttons in a browser or test multi-tab interaction.

7. **Operational/security work is intentionally modest.**
   Tokens are stored as readable database fields; sessions/state are hashed.
   Treat DB access/backups accordingly. The refresh function holds a row lock
   during its bounded network request to serialize rotating tokens. Most routes
   return safe generic errors but have little server-side diagnostic context.
   Worker terminal-failure persistence can itself fail during a DB outage; the new
   recovery loop reconciles terminal queue states after availability/lease expiry.
   There is no disconnect/logout UI or production deployment hardening. No dependency
   audit was performed. Recovery tests simulate crashes by creating orphan records,
   removing isolated queue jobs, and expiring leases; they do not kill production
   Redis or worker processes.

8. **Integration test timing needs a follow-up if it recurs.**
   The final-attempt recovery test in `tests/activity-sync.test.mjs` timed out once
   waiting for a BullMQ completion notification, then passed twice. Investigate
   worker/job state and QueueEvents lifecycle on recurrence; increasing the timeout
   alone would hide evidence. No production failure was established by this test.

## Names, singleton functions, and abstractions

- **Keep the Prisma singleton and cached queue factories.** They own expensive
  connections and prevent hot-reload duplication. Two typed queue producers share
  one physical queue but have different payload types and retry defaults. There
  is not enough complexity to justify a generic queue factory framework.
- **A function used once is not automatically useless.** `scheduleWorkout`,
  `serializeSavedPlan`, and `mapStravaSportToActivityType` give a name to domain
  behavior or an input/output boundary. Inline a helper when its name adds no
  meaning and it merely forwards arguments; do not inline a transaction or a
  resource-lifecycle boundary just to reduce the number of functions.
- **Keep DB operations in the DB package.** Small functions such as
  `recordSyncFailure` are useful boundaries used by the worker; replacing them
  with Prisma calls throughout the worker would violate the architecture.
- **Keep the refresh callback injection.** `getValidStravaAccessToken` controls
  locking/storage while the supplied refresh function handles HTTP. It is a small,
  useful separation, not a service/repository abstraction hierarchy.
- **Prefer domain names when the scope is long.** `syncRun` is clearer than `run`
  in triathlon code. Short loop names and conventional `tx` for a Prisma transaction
  are reasonable. Do not rename Strava's snake_case JSON fields just for style;
  those names deliberately match the provider contract.
- **Local response helpers are acceptable duplication.** The short `json` helpers
  consistently attach `no-store`. A new generic API/auth wrapper would hide control
  flow for little benefit. The new health helpers are reused by three entry points
  and centralize connection cleanup and safe errors.
- **Keep UI extraction proportional.** The form handlers and sport table are now
  easier to scan. The planner still combines editing, requests, and rendering.
  Split the goal form or plan details into another file when either acquires
  substantial behavior; the current local helpers are sufficient for this MVP.

## Complete file map

Paths below are relative to the repository root (the inner `strava-training-planner`
directory containing `package.json`). Review source, not generated output.
Calendar UI follow-up: the dashboard now displays completed and planned training in
a month grid. Review the calendar range/storage boundary and the dialog/fetch state
in the new files below. The calendar is separate from planned-vs-actual matching.

### Shared package

| File | Responsibility and review focus | Your CR notes |
| --- | --- | --- |
| [packages/shared/src/planner.ts](../packages/shared/src/planner.ts) | Workout templates, goal/plan schemas, schedule, generation, and snapshot validation. Highest priority for training-policy review. | |
| [packages/shared/src/calendar.ts](../packages/shared/src/calendar.ts) | Validates month input, calculates full UTC calendar weeks, and defines the calendar response contract. | |
| [packages/shared/src/training.ts](../packages/shared/src/training.ts) | Pure UTC weekly aggregation and date helpers. Check boundaries, units, and missing-history semantics. | |
| [packages/shared/src/jobSchemas.ts](../packages/shared/src/jobSchemas.ts) | Zod contracts for Ping and sync job payloads. Sync carries only a persistent run ID. | |
| [packages/shared/src/queue.ts](../packages/shared/src/queue.ts) | Queue/job names, history window, attempt count, deterministic sync job IDs. Coordinate producer/consumer edits here. | |
| [packages/shared/src/redis.ts](../packages/shared/src/redis.ts) | Converts Redis URLs to plain BullMQ connection options, including database/auth/TLS. Avoid reintroducing cross-package ioredis instance typing. | |
| [packages/shared/src/stravaSchemas.ts](../packages/shared/src/stravaSchemas.ts) | Provider response validation, scope parsing, dashboard transport types. Check ranges and nullable/optional fields. | |
| [packages/shared/src/strava.ts](../packages/shared/src/strava.ts) | Server-side token exchange/refresh, activity HTTP calls, safe provider errors, and rate-limit delay calculation. Keep out of client UI imports. | |
| [packages/shared/src/index.ts](../packages/shared/src/index.ts) | Public exports of contracts and pure logic; intentionally excludes the Strava HTTP module. | |
| [packages/shared/package.json](../packages/shared/package.json) | ESM package exports to compiled `dist`, plus the separate `@pkg/shared/strava` entry. | |
| [packages/shared/tsconfig.json](../packages/shared/tsconfig.json) | NodeNext compilation and declaration output. | |

### Database package

| File | Responsibility and review focus | Your CR notes |
| --- | --- | --- |
| [packages/db/src/client.ts](../packages/db/src/client.ts) | Prisma/pg adapter initialization and development client cache. Review lifetime and environment loading. | |
| [packages/db/src/strava.ts](../packages/db/src/strava.ts) | OAuth state/session storage, account association, token storage and row-locked refresh. High priority for transaction/identity review. | |
| [packages/db/src/activities.ts](../packages/db/src/activities.ts) | Sync-record lifecycle, activity mapping and transactional upserts, dashboard reads. High priority for retry/idempotency/ownership review. | |
| [packages/db/src/training.ts](../packages/db/src/training.ts) | Loads all relevant user activities for the pure summary calculator; accepts the caller's transaction so plan reads stay under its lock. | |
| [packages/db/src/training-lock.ts](../packages/db/src/training-lock.ts) | Shared per-user advisory lock and bounded wait for sync creation and plan generation. Internal DB helper, not a cross-app lock service. | |
| [packages/db/src/planner.ts](../packages/db/src/planner.ts) | Per-user goals, current/next plan loading, transactional sync guard, and one-plan-per-week upsert. | |
| [packages/db/src/calendar.ts](../packages/db/src/calendar.ts) | Loads every activity and saved plan in the visible weeks for the session user; serializes dates/IDs and validates plan snapshots. | |
| [packages/db/src/index.ts](../packages/db/src/index.ts) | Public DB-package exports. | |
| [packages/db/prisma/schema.prisma](../packages/db/prisma/schema.prisma) | Tables, enums, ownership relations, cascade rules, and uniqueness. Note nullable email, unique Strava activity ID, and unique user/week plan. Unused load/role/job-enum fields are retained to avoid gratuitous migrations. | |
| [packages/db/prisma/migrations/20260108191410_init/migration.sql](../packages/db/prisma/migrations/20260108191410_init/migration.sql) | Initial users, activities, jobs, enums, and indexes. Historical: do not edit applied migrations. | |
| [packages/db/prisma/migrations/20260904000000_strava_oauth/migration.sql](../packages/db/prisma/migrations/20260904000000_strava_oauth/migration.sql) | Nullable email plus OAuth connection, session, and state tables. | |
| [packages/db/prisma/migrations/20260904010000_activity_sync/migration.sql](../packages/db/prisma/migrations/20260904010000_activity_sync/migration.sql) | Last successful sync, activity names, processed activity count. | |
| [packages/db/prisma/migrations/20260904020000_weekly_planner/migration.sql](../packages/db/prisma/migrations/20260904020000_weekly_planner/migration.sql) | Weekly plan snapshots and user/week uniqueness. | |
| [packages/db/prisma/migrations/20260904030000_weekly_goals/migration.sql](../packages/db/prisma/migrations/20260904030000_weekly_goals/migration.sql) | Per-user nullable minute goals. Range/step validation currently lives in shared Zod, not SQL CHECK constraints. | |
| [packages/db/prisma/migrations/20260905000000_sync_recovery/migration.sql](../packages/db/prisma/migrations/20260905000000_sync_recovery/migration.sql) | Persisted sync attempt count, next retry time, and execution lease; short grace period for existing running records. | |
| [packages/db/prisma/migrations/migration_lock.toml](../packages/db/prisma/migrations/migration_lock.toml) | Prisma migration provider marker. | |
| [packages/db/prisma.config.js](../packages/db/prisma.config.js) | Prisma CLI schema/migration paths and root environment loading. Now uses ESM. | |
| [packages/db/package.json](../packages/db/package.json) | Prisma/adapter dependencies and compiled package exports. | |
| [packages/db/tsconfig.json](../packages/db/tsconfig.json) | NodeNext build/declaration settings. | |

### Worker application

| File | Responsibility and review focus | Your CR notes |
| --- | --- | --- |
| [apps/worker/src/index.ts](../apps/worker/src/index.ts) | Loads environment before DB consumers, configures the worker's Redis connection, starts worker/recovery, logs failures, and shuts down resources. | |
| [apps/worker/src/processor.ts](../apps/worker/src/processor.ts) | Job dispatch/validation, paginated ingestion, ownership check, one refresh after 401, retry classification and backoff. Main worker review target. | |
| [apps/worker/src/recovery.ts](../apps/worker/src/recovery.ts) | Startup/periodic reconciliation of DB intents against BullMQ, retry/lease preservation, terminal state handling, bounded Redis connection lifecycle. | |
| [apps/worker/package.json](../apps/worker/package.json) | Separate dev/build/start commands and runtime dependencies. Dev currently runs once, without a file watcher. | |
| [apps/worker/tsconfig.json](../apps/worker/tsconfig.json) | Extends root strict settings, emits NodeNext worker code into `dist`. | |

### Web application

| File | Responsibility and review focus | Your CR notes |
| --- | --- | --- |
| [apps/web/src/app/page.tsx](../apps/web/src/app/page.tsx) | Server-rendered entry: resolves session, connection, activity data, planner data, and OAuth status messages. | |
| [apps/web/src/app/activity-dashboard.tsx](../apps/web/src/app/activity-dashboard.tsx) | Sync button, bounded polling, calendar refresh after sync/generation, and collapsible planner/summary controls. | |
| [apps/web/src/app/training-calendar.tsx](../apps/web/src/app/training-calendar.tsx) | Month grid, completed/planned cards, weekly totals, navigation, cancellable fetching/retry, and accessible workout detail dialog. | |
| [apps/web/src/app/training-summary.tsx](../apps/web/src/app/training-summary.tsx) | Weekly cards/table, units, missing-distance presentation. | |
| [apps/web/src/app/weekly-planner.tsx](../apps/web/src/app/weekly-planner.tsx) | Goal form, save/generate calls, assumptions and unscheduled totals; tells the dashboard when generation succeeds. Workout steps now appear through the calendar dialog. | |
| [apps/web/src/app/layout.tsx](../apps/web/src/app/layout.tsx) | HTML shell, metadata, Google font setup. Builds need font access unless cached. | |
| [apps/web/src/app/globals.css](../apps/web/src/app/globals.css) | Tailwind import, theme variables, base styling. | |
| [apps/web/src/app/favicon.ico](../apps/web/src/app/favicon.ico) | Static browser icon; low review priority. | |
| [apps/web/src/app/health/page.tsx](../apps/web/src/app/health/page.tsx) | Dynamic dependency status page; invokes probes directly. | |
| [apps/web/src/app/api/enqueue/ping/route.ts](../apps/web/src/app/api/enqueue/ping/route.ts) | Validates/enqueues Ping only when the web process explicitly enables testing diagnostics; otherwise returns 404. | |
| [apps/web/src/app/api/strava/connect/route.ts](../apps/web/src/app/api/strava/connect/route.ts) | Origin check, expiring OAuth state, authorization redirect. | |
| [apps/web/src/app/api/strava/callback/route.ts](../apps/web/src/app/api/strava/callback/route.ts) | Consume state, exchange code, verify scopes, store authorization, rotate browser session. | |
| [apps/web/src/app/api/strava/refresh/route.ts](../apps/web/src/app/api/strava/refresh/route.ts) | Authenticated token-validity/refresh check; returns metadata, never tokens. | |
| [apps/web/src/app/api/strava/sync/route.ts](../apps/web/src/app/api/strava/sync/route.ts) | Authenticated status GET and origin-checked enqueue POST. Review DB/queue failure ordering. | |
| [apps/web/src/app/api/planner/route.ts](../apps/web/src/app/api/planner/route.ts) | Authenticated plan GET, generate POST, strict goals PATCH. User identity always comes from session. | |
| [apps/web/src/app/api/calendar/route.ts](../apps/web/src/app/api/calendar/route.ts) | Session-protected month GET; validates the bounded date range and returns uncached, user-scoped records. | |
| [apps/web/src/app/api/postgres_health/route.ts](../apps/web/src/app/api/postgres_health/route.ts) | Safe, uncached Postgres probe JSON and status. | |
| [apps/web/src/app/api/redis_health/route.ts](../apps/web/src/app/api/redis_health/route.ts) | Safe, uncached Redis probe JSON and status. | |
| [apps/web/src/lib/strava-auth.ts](../apps/web/src/lib/strava-auth.ts) | Config checks, cookie options, token generation/hashing, constant-time state comparison, session lookup. | |
| [apps/web/src/lib/queue.ts](../apps/web/src/lib/queue.ts) | Lazy typed producers, hot-reload caches, retry/retention defaults, bounded readiness wait. | |
| [apps/web/src/lib/health.ts](../apps/web/src/lib/health.ts) | Shared dependency probes; safe public messages and owned Redis connection cleanup. | |
| [apps/web/package.json](../apps/web/package.json) | Next/React dependencies and web commands. | |
| [apps/web/tsconfig.json](../apps/web/tsconfig.json) | Next's bundler module resolution and `@/*` source alias. It intentionally differs from worker NodeNext settings. | |
| [apps/web/next.config.ts](../apps/web/next.config.ts) | Next configuration, currently defaults. | |
| [apps/web/next-env.d.ts](../apps/web/next-env.d.ts) | Next-generated type references; not application logic. | |
| [apps/web/eslint.config.mjs](../apps/web/eslint.config.mjs) | Next/TypeScript lint rules and generated-file ignores. | |
| [apps/web/postcss.config.mjs](../apps/web/postcss.config.mjs) | Tailwind PostCSS plugin. | |
| [apps/web/.env.example](../apps/web/.env.example) | Placeholder web environment template; Next reads app-local configuration. | |
| [apps/web/public/file.svg](../apps/web/public/file.svg) | Unused scaffold file icon. | |
| [apps/web/public/globe.svg](../apps/web/public/globe.svg) | Unused scaffold globe icon. | |
| [apps/web/public/window.svg](../apps/web/public/window.svg) | Unused scaffold window icon. | |
| [apps/web/public/next.svg](../apps/web/public/next.svg) | Unused scaffold Next logo. | |
| [apps/web/public/vercel.svg](../apps/web/public/vercel.svg) | Unused scaffold Vercel logo. These static assets are harmless and were not removed just for tidiness. | |

### Tests, scripts, and root files

| File | Responsibility and review focus | Your CR notes |
| --- | --- | --- |
| [tests/strava-oauth.test.mjs](../tests/strava-oauth.test.mjs) | OAuth state, scopes, session isolation, expiry, token rotation, and concurrent refresh. Real isolated Postgres; mocked provider. | |
| [tests/activity-sync.test.mjs](../tests/activity-sync.test.mjs) | Real isolated queue/DB integration: pagination, retries, ownership, idempotency, route guards, missing-job recovery, leases, terminal errors, and persisted attempt limits. | |
| [tests/training-summary.test.mjs](../tests/training-summary.test.mjs) | UTC/date/aggregation edge cases and full-window DB/user filtering. | |
| [tests/planner.test.mjs](../tests/planner.test.mjs) | Policy examples, invariants, persistence, goals, old snapshots, auth and concurrency. Read these with the planner implementation. | |
| [tests/health.test.mjs](../tests/health.test.mjs) | Live dependency probes, real isolated schema failure, unreachable Redis, and generic failure responses. | |
| [tests/calendar.test.mjs](../tests/calendar.test.mjs) | UTC/month/leap-year boundaries, invalid ranges, session isolation, more than 30 activities, and historical plans alongside completed activities. | |
| [scripts/test-strava.mjs](../scripts/test-strava.mjs) | Shared integration harness despite its historical name: creates a random DB, migrates it, runs one suite, and removes only that DB. Sync gets the same unique Redis prefix. Review cleanup protections before modifying. | |
| [scripts/smoke-ping.mjs](../scripts/smoke-ping.mjs) | HTTP-to-queue-to-worker smoke test, invalid payload/unknown job rejection, removal of its own jobs. Requires running web/worker. | |
| [tests/ping-route.test.mjs](../tests/ping-route.test.mjs) | Tests default-off diagnostics, exact environment opt-in, rejection of request-level bypasses, and enabled payload validation without external services. | |
| [docs/product-vision.md](../docs/product-vision.md) | Product direction, expanded pre-AI scope, and deferred capabilities; use alongside the live MVP checklist. | |
| [docs/design.md](../docs/design.md) | Detailed system design, current behavior versus proposals, data/API contracts, failure handling, planner rules, and numbered decisions for change review. | |
| [package.json](../package.json) | Workspace membership and ordered build/test/dev commands. `db:reset` and `db:recreate` are destructive tools, not routine validation commands. | |
| [package-lock.json](../package-lock.json) | npm-generated resolved dependency graph. Review dependency diffs; do not hand-edit. No dependency upgrade was made in this review. | |
| [tsconfig.json](../tsconfig.json) | Root strict compiler settings, currently inherited by worker; web/shared/db have their own configs. | |
| [docker-compose.yml](../docker-compose.yml) | Local Postgres/Redis, persistent volumes, dependency health checks, and loopback port mappings. | |
| [.gitignore](../.gitignore) | Excludes dependencies, build outputs, real environment files, logs, and editor files. | |
| [.env.example](../.env.example) | Canonical root placeholder settings for Compose, worker, scripts, and Prisma. | |
| [README.md](../README.md) | Setup, architecture behavior, planner rules, commands, and operational assumptions. | |
| [docs/mvp-status.md](../docs/mvp-status.md) | Running milestone and validation checklist. Historical test counts refer to their milestone runs. | |
| [docs/code-review.md](../docs/code-review.md) | This review, remaining findings, file map, and manual review instructions. | |

Private `.env` and `apps/web/.env.local` hold local runtime settings, not reviewable
application source. Their values are not reproduced here. The obsolete tracked
`.env_example` and unused `apps/web/src/lib/redis.ts` were removed in this review.
The September 5 readability pass also removed the single-use worker Redis wrapper;
its options now live at the worker construction site.

`packages/*/dist/*.js`, `apps/worker/dist/*.js`, `*.d.ts`, and their maps are generated
from the matching `src/*.ts` files. For example, review `packages/db/src/activities.ts`,
not the `packages/db/dist/activities.js` file currently open in your editor. `.next`,
`node_modules`, and `*.tsbuildinfo` are generated/cache content and excluded from the
file map. The generated declaration maps help IDE navigation; do not edit them.

## Validation and your manual pass

Automated validation for this review: 62 integration tests (23 planner, 14 sync,
13 OAuth, 9 summaries, 3 health), all workspace typechecks, web ESLint, full worker/web
production build, and Compose configuration validation. Provider behavior is mocked
in the integration suites; these are not fresh live-Strava authorization tests.
The production Ping HTTP -> Redis/BullMQ -> worker smoke test also passed using
an isolated queue prefix. `/health`, both health APIs, and the authenticated
dashboard/planner read passed on port 3100 against the local services. Existing
activities, goals, and saved plans were not modified by those HTTP checks.

Decision 2 follow-up validation: 27 planner, 27 sync/recovery, and 9 summary tests
passed, plus workspace typechecks and the full production build. New concurrency
tests coordinate actual Postgres locks to reproduce both request orderings and
verify rollback cleanup and independent-user progress. No latency/load benchmark
was performed; the lock is scoped to one user and contains no network ingestion.

For your own UI review, restart `npm run dev` after the shared/worker changes, then:

Calendar follow-up browser checks passed with disposable Postgres fixtures and
headless Chrome: compact colored cards, details on click, Escape/focus return,
month navigation, regeneration refresh, mobile containment, and failed-load retry.
Five persistent calendar API/storage tests also pass. Inspect a week containing
both activity and plan entries; green activities do not automatically remove blue
workouts. Use the collapsible controls below the grid for the checks that follow.

1. Check the connected dashboard and compare a week's minutes against stored
   activities. Be explicit about UTC boundaries and moving time.
2. Save run 90, bike 150, swim 60; generate a 300-minute plan. Reload and check that
   both the goals and saved plan persist.
3. Try blank versus zero, an invalid 12-minute input, a goal above capacity, and
   switching back to automatic. Saving goals alone should not mutate the plan.
4. Sync and check queued/running/success, last successful time, and updated totals.
   Regenerate explicitly to use changed history.
5. Visit `/health` on the same port as your app. Remember: healthy dependencies
   do not prove a worker is running; the Ping smoke test checks that path.
6. Review the outstanding failure windows above before spending time renaming
   short loop variables or splitting small helpers into new files.
