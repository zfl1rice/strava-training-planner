# Pre-AI integration checklist

Each step is validated and committed separately. No model calls or AI credentials
are introduced by this sequence.

- [x] Expand the workout format: v2 custom workouts, stable IDs, repeated interval
  blocks, intensity targets, multiple sessions per date, compatible v1 reads.
- [x] Replace fixed scheduling: configured local days, session/time/pool limits,
  restrictions, rest days, and explicit shortfalls replace the v1 template caps.
- [x] Resolve workout targets: saved numeric target snapshots, running threshold
  pace input, relative intensity charts, and explicit missing baselines.
- [x] Add feedback and adjustment controls: completion, locks, RPE/comments,
  dated volume/intensity settings and explicit restrictions.
- [x] Implement regeneration boundaries: current remainder or next week; atomic
  replacement preserves past and protected workouts and their feedback.
- [x] Prepare background generation: persistent request IDs, typed BullMQ delivery,
  retry/recovery, atomic plan-and-success writes, and browser status polling.
- [x] Finalize the AI input/output contract: provider proposals are validated against
  server-owned context; custom-workout fixtures pass and invalid proposals roll back.

V2 week timestamps encode local calendar labels at UTC midnight; they are not
scheduled start instants. Each plan records its timezone. Old v1 snapshots retain
their UTC interpretation. Custom interval duration must exactly match its blocks;
IDs must be unique, and each date contains workouts or one rest entry.

## Run and verify

After pulling, run `npm run db:generate`, `npm run db:deploy`, then restart both web
and worker with `npm run dev`. The new migration adds only `JobRun.planRequest`;
it has already been applied to the local development database for this change.
No new environment variables, dependencies, or services are required.

1. Configure your timezone/baselines in Profile, available days in Availability,
   and weekly minutes under the calendar's Plan settings & weekly goals section.
2. Generate next week. The web returns 202 and polls persistent status. Generation
   continues if you navigate away. If the worker is offline, the request waits.
3. Open a calendar workout to inspect interval steps, numeric targets, and the
   intensity chart. Record completion, RPE/comments, or a lock, then save feedback.
4. In Adjustments, add a dated volume/intensity change or restriction, then save.
   Request generation to apply it. Saving settings alone does not rewrite workouts.
5. Regenerate next week or the rest of this week. Past dates and completed, modified,
   stopped, or locked workouts remain. Calendar totals explain a shortfall against goals.

## Scheduling and target policy

- Unconfigured availability is unavailable. Date overrides replace recurring days.
  Daily minutes are shared across sessions, and swimming requires pool access.
- The generator allocates five-minute blocks, prioritizing sports with fewer
  eligible days. It can create several sessions per day and exceed the old template
  caps. It currently creates at most one new session of each sport per day.
- At least one day is reserved for rest. When all days are available, the least
  available day is reserved. New hard workouts cannot be consecutive or share a
  date with another hard workout; at most two are scheduled. Protected history is
  retained even when it exceeds new limits, and cannot justify adding more excess.
- Manual goals remain unchanged. Blank goals use the previous three completed
  local weeks. With no history and no custom goals, the target is zero; the planner
  explains how to configure inputs instead of guessing training volume.
- Temporary volume percentages are prorated across their dates in the target week.
  The last matching adjustment wins; percentages do not stack. Intensity changes
  apply on matching workout dates. Required hard-session spacing can limit increases.
- Relative targets support RPE, percentage of cycling FTP, running max HR, and
  running/swimming threshold pace. A pace percentage multiplies seconds per unit
  distance, so a higher percentage means slower pace. Numeric target snapshots
  retain their baseline and calculation timestamp; changing a profile does not
  silently rewrite saved workouts. Missing baselines are displayed explicitly.
- Effort classification uses the hardest target and conservative scheduling
  thresholds. Charts show relative targets, not measured power traces, normalized
  power, TSS, or a validated physiological load score. Custom zones remain stored
  but are not used as named-zone workout targets by this generator.
- Preserved v1 workouts are represented in the replacement v2 plan with the same
  dates, titles, durations, and instructions. Their original three steps become one
  structured block; v1 had no numeric intensity snapshot. Other saved v1 weeks are
  not migrated or rewritten.

## Generation contract and execution

`GenerationInputSchema` contains the validated PlanningContext, the first replaceable
date, and the exact protected workouts. Context includes goals, races and independent
importance scores, fitness/evidence, recent training, availability, restrictions,
adjustments, and up to 200 recent feedback entries from the current/prior four weeks.
Truncation is explicit. Free text is retained as data; no language model interprets it.

`PlanProposalSchema` permits only a version, explanation, and proposed replaceable
workouts. It cannot redefine goals, totals, athlete identity, or protected workouts.
See [the illustrative proposal](plan-proposal.example.json). The server recomputes
resolved targets, effort classifications, and totals. Validation rejects malformed
intervals, duplicate IDs, wrong dates, forbidden sports, missing pool access, daily
overbooking, excess adjusted volume, missing rest, and conflicting hard sessions.

`PlanProvider` is a small synchronous, CPU-only function at this checkpoint. The
deterministic implementation and simulated-provider tests use the same finalizer.
The job processor loads input from Postgres and commits the validated plan and
SUCCESS together. A duplicate delivery after success does not regenerate the plan.

Generation requests persist scope and week in `JobRun.planRequest`; BullMQ carries
only `{ jobRunId }`. Pending requests are reused when scope/week match. A different
request receives a conflict while one is pending. Recovery scans run at worker
startup and every 30 seconds. Attempts persist across Redis job loss, with a
three-attempt limit, exponential backoff, execution leases, and terminal status.
The same user training lock coordinates generation, sync intent, feedback, and
settings writes. Sync and pending/running generation exclude each other.

The next AI increment must add an asynchronous network-provider adapter without
holding this short database transaction during a model request. It must recheck
the input revision and protected state before committing a response, and maintain
the execution lease while waiting. No SDK, model, API key, prompt, or network model
call is included here. The current synchronous provider should not be replaced
with a blocking HTTP call inside the transaction.

## Review map

| File | Responsibility / review focus |
| --- | --- |
| [structured-workouts.ts](../packages/shared/src/structured-workouts.ts) | V2 interval/plan schemas and compatibility adapter for calendar reads. |
| [adaptive-planner.ts](../packages/shared/src/adaptive-planner.ts) | Allocation, availability/restrictions, adjustment policy, and hard-session spacing. Review this policy first. |
| [workout-targets.ts](../packages/shared/src/workout-targets.ts) | Percentage conversion, frozen numeric snapshots, descriptions, and conservative effort classification. |
| [plan-generation.ts](../packages/shared/src/plan-generation.ts) | Provider input/output contract and authoritative validation. Review mutation isolation and protected-workout checks. |
| [db/planner.ts](../packages/db/src/planner.ts) | Owned state reads, legacy compatibility, regeneration boundaries, and atomic replacement. |
| [plan-jobs.ts](../packages/db/src/plan-jobs.ts) | Request deduplication, persistent attempts/leases, atomic plan completion, and failure recovery. |
| [planning-context.ts](../packages/db/src/planning-context.ts) | Local-date snapshot and recent feedback collection. |
| [planning-settings.ts](../packages/db/src/planning-settings.ts) | Baseline, availability, adjustment, and restriction writes with stale-edit checks. |
| [workout-feedback.ts](../packages/db/src/workout-feedback.ts) | Owned per-workout feedback edits and optimistic concurrency. |
| [worker/processor.ts](../apps/worker/src/processor.ts), [plan-recovery.ts](../apps/worker/src/plan-recovery.ts) | Typed job dispatch and missing-job reconciliation. |
| [api/planner/route.ts](../apps/web/src/app/api/planner/route.ts), [workout-feedback/route.ts](../apps/web/src/app/api/workout-feedback/route.ts) | Session/origin checks and small request contracts. |
| [weekly-planner.tsx](../apps/web/src/app/weekly-planner.tsx) | Goal editor, generation scopes, and status polling across reloads. |
| [training-calendar.tsx](../apps/web/src/app/training-calendar.tsx), [workout-chart.tsx](../apps/web/src/app/workout-chart.tsx) | Local-date entries, shortfall notes, interval chart, and click-to-open details. |
| [workout-feedback-form.tsx](../apps/web/src/app/workout-feedback-form.tsx), [adjustments-form.tsx](../apps/web/src/app/settings/adjustments-form.tsx) | Feedback, temporary percentages, explicit restrictions, and saving behavior. |
| [adaptive-planner.test.mjs](../tests/adaptive-planner.test.mjs) | New integration/provider/job regressions. Run `npm run test:adaptive`. |
| [plan request migration](../packages/db/prisma/migrations/20260906020000_plan_requests/migration.sql) | One additive JSON column; existing plans and activity records are retained. |

## Deferred at this checkpoint

AI provider integration, race-specific periodization/intensity selection, automatic
PR detection and fitness updates, strengths/weaknesses scoring, inferred adjustments
from free-text feedback, load/TSS modeling, automatic activity-to-workout matching,
calendar integrations, and a custom-template editor remain deferred. Custom workouts
are supported by the data model and provider contract; the regular UI still invokes
the deterministic generator. Completed Strava activities remain separate from planned
workouts, even when a workout has completion feedback.

## Validation completed

125 tests pass: 19 adaptive/provider/job tests, 27 legacy planner/API tests,
28 sync/recovery tests, 13 OAuth tests, 10 PlanningContext tests, seven settings
tests, nine summary tests, five calendar tests, three health tests, and four
Ping-route tests. Workspace typechecks, ESLint, and the full production build pass.

Headless Chrome verified real HTTP enqueue through Redis and the compiled worker,
reloading while the worker was offline, later completion and calendar refresh,
numeric targets, feedback persistence, preserved completion during regeneration,
temporary volume changes, profile persistence, local timezone labeling, and mobile
navigation/overflow. Desktop/mobile screenshots were inspected. Browser fixtures
used a disposable database and separate Redis prefix; no real Strava call occurred.

The first legacy API regression run exposed assertions expecting synchronous 200
responses; those now check queued 202 responses and subsequent worker execution.
The updated suites pass. A browser selector was corrected to match dropdown labels;
the rerun passes. Temporary browser scripts and fixture databases were removed.
