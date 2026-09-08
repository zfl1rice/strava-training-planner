# Current architecture

This guide describes the implemented application. The [original design draft](design.md) is retained as design history, not current setup instructions. See the [README diagrams](../README.md#architecture) for the system at a glance.

## Process and ownership boundaries

| Component | Owns | Does not own |
| --- | --- | --- |
| `apps/web` | Next.js calendar/settings, Strava OAuth callback, opaque-cookie sessions, authenticated mutation endpoints, queue production and status polling | OpenAI credentials or long-running generation |
| `apps/worker` | BullMQ processing, paginated Strava ingestion, OpenAI proposal/review adapters, retry and recovery loops | Browser sessions or UI rendering |
| `packages/db` | Prisma services, Postgres records, per-athlete coordination, snapshots, leases and atomic commits | UI or model-authored authority |
| `packages/shared` | Zod contracts, dates, structured workouts, target resolution, constraints, block/review semantics and deterministic providers | Application credentials or connections |

Web and worker do not import one another. PostgreSQL is authoritative; sync, plan and review queue payloads contain only `{ jobRunId }`. The optional Ping diagnostic carries a user ID. Redis is the transport, not the sole record of outstanding work.

## Strava ingestion

1. The web callback validates OAuth state, exchanges the authorization code and stores athlete/token information and an opaque session in Postgres.
2. An authenticated sync request persists a job before trying to enqueue its ID.
3. The worker loads the job and stored connection, refreshes expired tokens through the serialized database service, and requests paginated activities in the last 90 days.
4. Each page uses upserts keyed by unique Strava activity ID. Ownership is checked before the page transaction commits.
5. The worker records progress and successful sync time. The UI reads saved activities and status. Transient errors use bounded retries/backoff; recovery reconciles missing queue work.

Source: [OAuth callback](../apps/web/src/app/api/strava/callback/route.ts), [worker processor](../apps/worker/src/processor.ts), [token storage/refresh](../packages/db/src/strava.ts), [activity persistence](../packages/db/src/activities.ts).

## Weekly planning boundary

The authenticated generation endpoint creates a starter strategy when needed, persists a generation request and enqueues its ID. The worker builds a bounded `PlanningContext` with goals, athlete-local dates, available days, baselines, race context, recent training, feedback and the active block. A generation input also identifies protected workouts and the replacement window.

The OpenAI adapter sends that context using `client.responses.create`, with `store: false`, a Zod-derived Structured Outputs format, explicit timeout/output limits and SDK retries disabled. It returns replaceable workout proposals, not database mutations. The proposal contract excludes server-owned weekly goals and totals.

The finalizer checks schema, arithmetic, IDs, dates, allowed sports, pool access, restrictions and daily/session limits. It recomputes effort labels and resolves percentage/RPE targets from saved baselines. The final stored-plan schema checks resulting totals and calendar coverage. Validation and resolution are one deterministic finalization boundary; a missing baseline is a correctable error, not permission to invent a target.

Invalid proposals receive issue codes, paths and messages. There are three proposal attempts total, including the first. Corrections and infrastructure retries are distinct: saved proposals can be reused on retry, but an interrupted external call may be repeated before its result is persisted.

Before accepting a result, the worker checks snapshot freshness and execution ownership/lease again under the training lock. It saves the plan and successful job state in the same transaction. No transaction spans the model call. Failed, invalid or stale proposals leave the previous calendar intact.

Source: [generation endpoint](../apps/web/src/app/api/planner/route.ts), [context builder](../packages/db/src/planning-context.ts), [transport](../apps/worker/src/openai-structured-response.ts), [proposal validation](../packages/shared/src/plan-generation.ts), [target resolution](../packages/shared/src/workout-targets.ts), [durable plan jobs](../packages/db/src/plan-jobs.ts).

## Strategic continuity and review

The deterministic block creator interprets race context and optional sport emphasis into a persistent `DevelopmentBlock`: phase, date range, week roles, sport/capability focuses, progression strategies and rationales. Relative emphasis is stored in athlete-profile JSON, separately from desired weekly minutes. Saving preferences does not rewrite the active block or calendar; explicit replanning records a successor and retains history.

Weekly generation consumes the active block and its applicable review guidance. A durable review job snapshots the saved week, reported completion/RPE/comments, recorded activity summaries and relevant settings. The model selects a global lifecycle decision and actions for the supplied focus IDs. Code validates exact focus coverage and lifecycle consistency, resolves server-owned focus metadata, and atomically appends the review and marks the job successful.

The global decision controls block progression/recovery/closure. Per-focus progress/hold/maintain actions allow different responses across sports. Completed and aborted blocks remain historical records. An in-progress review is permitted and explicitly marked partial.

**Evidence boundary:** the current DB context supplies unlinked activities. Reported completion refers to prescribed minutes, not measured execution. The shared evidence contract supports linked duration evidence for tests/future callers, but automatic linking and interval compliance are not implemented in the application. Unknown observations remain unknown.

Source: [block selection and UI state](../packages/db/src/training-block-state.ts), [block persistence](../packages/db/src/development-blocks.ts), [review jobs](../packages/db/src/review-jobs.ts), [review evidence](../packages/shared/src/block-review-evidence.ts), [review contract](../packages/shared/src/block-review.ts).

## Protected edits and recovery

- A short transaction-scoped advisory lock coordinates athlete operations; persistent pending/running job checks prevent sync, generation and review overlap.
- Leases and attempt counters fence late workers. Recomputing relevant input detects changes to goals, settings, history, feedback or strategy; athlete-local date rollover also invalidates work.
- Snapshot equality tolerates only floating-point round-off introduced by JSON/database serialization; it still rejects real input changes.
- Regeneration preserves past/locked/non-planned workouts. Clear-week additionally preserves all feedback-bearing workouts, checks plan revision and confirmation date, and updates only the selected plan.
- Recovery scans wait for bounded Redis initialization before closing temporary connections. Worker error listeners attach immediately; the Windows web dev script uses Webpack to avoid the reproduced Turbopack/PostCSS process-growth path.

These mechanisms provide bounded retries and guarded persistence, not exactly-once external execution or an uptime guarantee. Full physiology, medical safety and coaching optimality are outside deterministic validation.

## Verification entry points

- [Route → BullMQ → mocked OpenAI → Postgres → calendar integration](../tests/review-jobs.test.mjs)
- [Adaptive planner and stale-input regressions](../tests/adaptive-planner.test.mjs)
- [Strava ingestion/idempotency tests](../tests/activity-sync.test.mjs)
- [Training-focus persistence and clear-week protection tests](../tests/training-plan-ui.test.mjs)
- [Redis initialization/close regression](../tests/redis-lifecycle.test.mjs)
- [Current validation results](training-plan-ui.md#validation)

The README uses fenced Mermaid diagrams supported by [GitHub's Markdown renderer](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams).
