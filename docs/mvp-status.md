# Pre-AI MVP status

- [x] Typed PingJob: shared schema, web enqueue, Redis/BullMQ, worker validation
- [x] Strava OAuth and token refresh (implementation and simulated-provider integration tests)
- [x] Verify a real Strava account connection after configuring local API credentials
- [x] Idempotent activity synchronization with retries
- [x] Connection / sync / recent activities dashboard
- [ ] Weekly training summaries
- [ ] Template-based weekly plan

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

Next: basic weekly training summaries, followed by the template-based planner.

The health page still refers to the previously removed /api/health endpoint;
repair this when implementing the dashboard.

AI, calendar integration, advanced training models, and UI polish are deferred.
