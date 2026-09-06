# Pre-AI MVP status

The [detailed design draft](design.md) documents current behavior and open decisions.
Proposals in that document do not change the implementation status below.

## September 6 PlanningContext checkpoint

- [x] Additive profile, timezone, race, evidence-history, and workout-state storage.
- [x] Shared schemas and `buildPlanningContext`, with local summaries/date overrides.
- [x] Manual baseline precedence, custom zone preservation, and explicit missing evidence.
- [x] Seeded readable context and focused integration tests.
- [x] Profile, race-goal, and availability configuration UI (follow-up below).
- [ ] Fitness calculations, structured AI workouts, and OpenAI calls.

See [the checkpoint review guide](planning-context.md) and [seeded JSON](planning-context.example.json).
The fixed UTC deterministic planner remains available; protected workout metadata
now prevents it from overwriting locked/completed workouts.

## September 6 planning settings UI

- [x] Responsive sidebar: Calendar, Goals, Availability, Profile.
- [x] Timezone and manual cycling FTP, running maximum HR, and swim threshold pace.
- [x] Race creation, editing, deletion, and independent 0–100 importance scores.
- [x] Recurring day limits, permitted sports, pool access, and date overrides.
- [x] Authenticated storage, section-scoped edits, and stale-edit conflict handling.
- [x] Preserve estimates, custom zones, restrictions, and existing calendar workouts.
- [x] Seven settings integration tests, ten context regressions, and 27 planner
  regressions pass; workspace typechecks, lint, and production build pass.
- [x] Browser checks cover persistence, race CRUD, failure/retry, mobile navigation,
  and the unauthenticated state. Desktop/mobile screenshots inspected.
- [ ] Apply these settings when generating workouts; the current planner still
  uses its fixed UTC schedule.

See [implementation details, verification steps, and the review table](planning-settings.md).
No new dependency, migration, or AI call was added.

## Original MVP checklist

- [x] Typed PingJob: shared schema, web enqueue, Redis/BullMQ, worker validation
- [x] Strava OAuth and token refresh (implementation and simulated-provider integration tests)
- [x] Verify a real Strava account connection after configuring local API credentials
- [x] Idempotent activity synchronization with retries
- [x] Connection / sync / recent activities dashboard
- [x] Weekly training summaries
- [x] Template-based weekly plan
- [x] Configurable weekly run, bike, and swim time goals
- [x] Source review, focused cleanup, and file-by-file review guide
- [x] Decision 1: automatic recovery of missing activity-sync jobs
- [x] Decision 2: prevent plan generation and activity sync from overlapping
- [x] Decision 3: disable Ping diagnostics by default; explicitly enable for testing
- [x] Readability review: focused cleanup, terminal retry-message fix, and CR file table
- [x] Month calendar: green completed activities, blue plans, click-to-open details
- [x] Athlete/race configuration: race type/date, weekly availability, rest days,
  sport days, and session/time limits
- [ ] Additional profile inputs such as experience and restriction editing
- [ ] Extend the deterministic planner to use the profile, time until race, and
  availability; validate scheduling constraints and display the resulting week

The [product vision](product-vision.md) supplied September 5 expands the original
MVP with profile inputs and adaptive scheduling. Existing summaries, templates, and weekly
goals should be reused. Profile collection is now partially implemented; the
current fixed-day planner does not yet satisfy the expanded planning requirements.

## Verified PingJob milestone

All four workspace typechecks, shared/database compilation, worker compilation,
and the Next.js production build passed. The smoke test used the production web
server and compiled worker against the existing Docker Redis service. It confirmed:

- HTTP enqueue returns 202 and the worker returns the validated user ID.
- Invalid HTTP payloads return 400.
- Invalid queued payloads and unknown job names fail without retries.

The existing Prisma activity schema already has a unique Strava activity ID.
## OAuth milestone

- Connect button, authorization redirect, one-use state, scope validation, and callback.
- Athlete, access token, refresh token, expiry, and granted scopes saved in Postgres.
- Opaque browser sessions stored as hashes; session expiry enforced in Postgres.
- Reconnects reuse the athlete's user and rotate the current browser session.
- Token refresh reuses valid tokens and atomically saves rotated credentials.
- Concurrent refreshes serialize through a Postgres row lock.
- Migration applied to local Postgres without deleting existing records.
- 13 integration tests passed against an isolated database with simulated Strava responses.
- All workspace typechecks and the full production build passed; changed web files pass lint.
- Production HTTP checks passed for the home page, connect redirect, denied callback,
  replay rejection, session guard, and Postgres health. PingJob regression passed.

Real Strava authorization was confirmed by the user and subsequently verified by live activity ingestion.

## Activity synchronization milestone

- Session-protected POST enqueues a typed job containing only the Postgres sync-record ID.
- Repeated clicks reuse the active record and deterministic BullMQ job ID.
- Worker loads credentials from Postgres and fetches the last 90 days, paginating to an empty page.
- Activity names, sport categories, dates, moving time, distance, and elevation are upserted by unique Strava activity ID.
- Expired/rejected tokens refresh; transient errors retry up to five total attempts with backoff.
- Rate-limit responses wait for Retry-After or the appropriate Strava rate-limit reset.
- Postgres tracks progress, failures, and the last successful sync. Partial syncs preserve already-upserted pages.
- Dashboard polls progress and displays the latest 30 activities, with distances in km (swims in m).
- Live production HTTP -> BullMQ -> compiled worker -> Strava -> Postgres verification imported 28 activities.
  A second sync retained exactly 28 activities. The authenticated production page rendered successfully.
- All 14 sync integration tests and 13 OAuth regression tests passed, along with
  typechecks, production builds, changed web-file lint, and the PingJob smoke test.

## Weekly training summaries milestone

- Current week plus the previous three calendar weeks, Monday 00:00 UTC to the next Monday.
- Run, bike, and swim moving minutes and distance; other activity time shown separately.
- Total weekly time includes all stored activity types.
- Previous three complete weeks have a weekly average; the unfinished current week is excluded.
- Empty weeks remain visible as zero; missing distances are marked as unavailable or partial.
- Every activity in the window is counted, independently of the latest-30 activity display.
- Database queries remain scoped to the signed-in user. Summaries refresh with sync progress.
- No schema migration or additional Strava requests required.
- Nine summary tests and all 14 sync regression tests passed. Workspace typechecks,
  production builds, and changed UI-file lint passed.
- Authenticated production page verified; per-sport totals matched independent Postgres aggregates.

## Template planner milestone

- Shared structured swim, bike, and run templates with duration limits and easy effort.
- Per-sport budgets use three completed weeks, exclude other sports/current week,
  round down to five-minute blocks, and do not automatically increase recorded volume.
- Small budgets reduce session count; capped durations leave surplus minutes unused.
- One session per day, Monday rest, easy sessions only, and validated durations/totals.
- Sparse history is disclosed; no completed-week triathlon history offers an optional
  generic starter schedule, explicitly not a fitness estimate.
- Authenticated generation saves one validated plan per user/week in Postgres.
- Regeneration updates next week's plan; saved current-week plans remain accessible.
- Generation waits for pending/running activity sync; assumptions disclose missing/failed sync.
- 16 planner tests passed, covering budgets, templates, persistence, concurrency,
  week rollover, and session protection.
- All 52 planner/summary/sync/OAuth tests, workspace typechecks, production builds,
  changed UI lint, and PingJob smoke checks passed.
- Generated and saved a real plan from the connected account's stored activity history.
  Authenticated production generation, API reload, and seven-day page rendering passed.
  The local database matches all migrations.

## Weekly goal configuration

- Per-user time goals persist in Postgres through a session-protected, validated API.
- Blank means automatic; zero skips a sport; custom goals use five-minute increments.
- Custom targets override history while preserving template duration and scheduling limits.
- Requested versus planned totals disclose minutes that cannot fit the templates.
- Goals apply on explicit generation/regeneration; saved plans retain their goal snapshot.
- Existing plan snapshots remain readable without a data rewrite.
- All 23 planner tests, workspace typechecks, changed-file lint, and production build passed.
- The additive migration is applied to local Postgres.
- Authenticated production API and rendered three-field goals form verified against
  the connected account; existing goals and plans were left intact.

The original pre-AI flow works: Strava -> asynchronous ingestion -> Postgres
-> weekly summaries -> template-based weekly plan -> web UI. The expanded MVP
still needs athlete/race inputs and availability-aware planning, listed above.
LLM integration remains deferred.

## Code review follow-up

- See [the code review guide](code-review.md) for a complete file map, changes,
  outstanding findings, and suggested review order.
- Fixed health page routing, public error leakage, and Redis probe cleanup/timeouts.
- Removed unused Redis/shared exports and the obsolete environment example;
  local Compose ports now bind to loopback (applies on next Compose up).
- Clarified domain names and planner scheduling; validated workout slots.
- Retained useful Prisma/queue singletons and the existing application boundaries.
- All 62 integration tests, workspace typechecks, web lint, full production build,
  and Compose config validation passed. Production Ping smoke, health routes,
  authenticated dashboard rendering, and planner reads passed.
- Queue/DB recovery, planner/sync concurrency, and diagnostic endpoint access were
  addressed by decisions 1–3 below.

## Decision 1: automatic sync recovery (September 5)

- User selected automatic recovery; implemented inside the existing worker.
- Startup and 30-second scans recreate missing jobs from unfinished Postgres records.
- Existing active/waiting/paused/delayed jobs remain untouched; terminal DB records
  are never restarted. Terminal queue states are reconciled after lease expiry.
- Enqueue failures/lost acknowledgements retain the accepted request for recovery.
- Attempt counts and retry dates persist across Redis job loss; five-start limit.
- Two-minute renewable execution leases and attempt-guarded writes protect against
  an old processor overwriting a replacement attempt's pages or final status.
- Recovery preserves the original sync time window and idempotent page upserts.
- Additive migration applied locally; 27 sync/recovery tests and 23 planner tests pass.
- All workspace typechecks, web lint, and the full production build pass.
- Compiled worker startup and production Ping web-to-worker smoke passed with an
  isolated Redis prefix; no live activity sync was triggered by the check.
- Decision 2 is implemented below.

## Decision 2: coordinate sync and plan generation (September 5)

- User selected no overlap; enforced per user in Postgres across tabs/processes.
- Sync creation and generation use the same transaction-scoped advisory lock.
- Generation checks pending/running syncs after taking the lock, then reads history
  and goals and saves the plan within that same transaction.
- Existing pending/running/retrying/recovering syncs return 409; a sync arriving
  during generation waits for the plan to commit before its request is saved.
- Lock waits are capped at five seconds, transactions at ten; failures roll back.
- No lock spans Strava API calls; other users do not wait on this user's lock.
- No new migration, framework, service, or queue payload change.
- 27 planner tests pass, including real-lock tests for both request orderings,
  independent users, pending/running rejection, and lock release after save failure.
- All 27 sync/recovery and 9 summary regressions also pass (63 tests this change),
  along with workspace typechecks and the full production build.

## Decision 3: Ping diagnostics only for testing (September 5)

- Disabled by default in both development and production; POST returns 404 with
  `Cache-Control: no-store` before reading the body or creating a Redis client.
- Only `ENABLE_PING_DIAGNOSTICS=true` in the web process enables diagnostics.
- Example environment defaults to false; smoke-test instructions explain temporary
  opt-in and restarting without the flag afterward. No real environment files changed.
- Four route tests pass: default/invalid flags, request-level bypass attempts,
  enabled payload validation, and disabling again.
- Workspace typechecks, web lint, and full production build pass.
- Built web verified with the flag absent (404), then enabled against the compiled
  worker and Redis (typed Ping, invalid payload, and unknown job checks pass).
- Smoke tests used an isolated queue prefix; no live Strava sync was triggered.

AI, calendar integration, advanced training models, and UI polish are deferred.

## September 5 readability review

- Simplified the worker connection setup and queue cache declarations.
- Clarified sync/lease names, retry branches, planner state, budget checks, and form handlers.
- Removed redundant plan validation and inactive TypeScript scaffold comments.
- Corrected exhausted rate-limit failures that incorrectly promised another retry.
- Preserved architecture, planner policy, migrations, and existing user data.
- Updated [the review guide](code-review.md) with changes, outstanding findings,
  clickable file responsibilities, and a blank CR column.
- All 84 tests, workspace typechecks, web lint, production build, and compiled
  web-to-worker Ping smoke pass. One initial sync-test timeout did not reproduce
  on the next two runs; the guide records it as an unresolved intermittent issue.

## Training calendar UI

- Calendar is the main view, with Monday–Sunday columns, month navigation, Today,
  current-day highlighting, and separate weekly completed/planned totals.
- Green Strava activities and blue planned workouts show concise duration/title
  cards. Details open in a native dialog with keyboard dismissal and focus return.
- All saved records in the visible weeks are loaded from Postgres through an
  authenticated, uncached calendar endpoint, independently of the 30-row preview.
- Historical plans appear when navigating back. Completed and planned workouts
  remain separate; automatic matching is not implemented.
- Sync completion and generation refresh the calendar. Goals and summaries are
  still available in collapsible sections below it.
- Five calendar tests plus 27 planner and 9 summary regressions pass (41 tests),
  along with workspace typechecks, web lint, and the production build.
- Headless Chrome checks with isolated fixtures verified colors/entries, hidden
  steps, dialog click/Escape/focus behavior, month navigation, generation refresh,
  mobile overflow containment, and request failure/retry. No browser runtime errors.
- Desktop/mobile screenshots inspected. No new runtime dependency, migration,
  change to planning rules, or live Strava request was required.
