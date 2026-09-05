# Pre-AI MVP status

- [x] Typed PingJob: shared schema, web enqueue, Redis/BullMQ, worker validation
- [x] Strava OAuth and token refresh (implementation and simulated-provider integration tests)
- [ ] Verify a real Strava account connection after configuring local API credentials
- [ ] Idempotent activity synchronization with retries
- [ ] Connection / sync / recent activities dashboard
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

Real Strava credentials are not configured locally yet. See README for setup.
Only the connection section of the dashboard is implemented; syncing remains next.

The health page still refers to the previously removed /api/health endpoint;
repair this when implementing the dashboard.

AI, calendar integration, advanced training models, and UI polish are deferred.
