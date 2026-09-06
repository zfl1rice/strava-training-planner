# PlanningContext checkpoint — September 6, 2026

This milestone supplies database-backed planning inputs. It does not call an LLM,
generate AI workouts, or change the existing calendar's scheduling policy. The
OpenAI API is the chosen future execution route; no API client or keys were added.

The subsequent [planning settings UI](planning-settings.md) exposes manual baselines,
timezone, races, and availability through authenticated forms. The audit below
describes the original foundation checkpoint, before those screens were added.

## Audit

The working tree already contained OAuth, activity ingestion/recovery, summaries,
weekly goals, deterministic v1 plans, and a calendar. Existing uncommitted calendar
and documentation changes were preserved. There were no persisted fitness, race,
availability, restriction, performance-history, or workout-state models.

The v1 generator takes `TrainingSummary` and `WeeklyGoals`, using three completed
UTC weeks. Its six fixed slots, Monday rest, easy workouts, and template caps remain
unchanged. Reused components include sport/goal schemas, v1 snapshot validation,
numeric summary aggregation, the training lock, and the isolated test harness.

## Storage decisions

| Storage | Implements |
| --- | --- |
| `User.timeZone` | Valid timezone identifier, default UTC for existing users. |
| `AthleteProfile.content` | One versioned, strict JSON object for fitness definitions, capability estimates, recurring availability, date overrides, and restrictions. Avoids a table per setting. |
| `RaceGoal` | Relational ownership, date, and importance for querying. Remaining race fields and a reusable demand profile are validated JSON. Date and importance are not duplicated in JSON. |
| `PerformanceEvidence` | Append-only observations with benchmark, value, sport, source, time, PR/estimate flags, calculation version, and optional source activity. History is not overwritten by later PRs. |
| `WeeklyPlan.workoutStates` | Additive metadata for date/template identity, locks, completion, and feedback. V1 plan content is unchanged. |

The migrations add three tables and two columns, then give the evidence index an
explicit name below PostgreSQL's identifier-length limit. Existing rows are not
deleted or rewritten. Database checks constrain importance and evidence values/types;
JSON is validated by shared schemas on write and read. Deleting a source activity
nulls its evidence link rather than removing the observation. User deletion cascades
owned records. Future effort ingestion must provide detection and deduplication.

## PlanningContext shape

```ts
{
  version: 1,
  generatedAt,
  athlete: { id, timeZone },
  targetWeek: { startDate, endDate },
  goals: { RUN, BIKE, SWIM },
  fitness: {
    definitions: { cycling, running, swimming },
    effective: { cycling, running, swimming }
  },
  performanceProfile: {
    cycling, running, swimming,
    evidence, historyRecordCount, evidenceTruncated
  },
  races: [{ id, goal: { /* fields, importance, demandProfile */ } }],
  recentTraining,
  availability: { recurring, days },
  restrictions,
  existingPlans: [{ id, updatedAt, content, workoutStates }],
  dataQuality: { lastSuccessfulSyncAt, syncInProgress, latestSyncStatus, notes }
}
```

See [the complete seeded JSON](planning-context.example.json). It contains fabricated
test data, not connected-athlete records or credentials.

### Fitness, zones, and performance

Cycling's baseline is FTP in watts, running's is maximum HR in bpm, and swimming's
is threshold pace in explicitly preserved seconds per 100 meters or 100 yards.
Definitions retain manual and estimated values, dates, and evidence references.
Effective values follow manual → estimate → missing. The builder calculates no
estimates and updates no baselines.

Zones support `DERIVED` and `CUSTOM`. Custom numeric intervals are lower-inclusive,
upper-exclusive, ordered, and nonoverlapping, with null for an unbounded upper limit.
Custom definitions persist independently of baseline edits. For swim pace, smaller
numbers mean faster swimming; boundaries are ordered numerically. The context
returns zone configuration, not calculated derived boundaries. Cycling/HR formulas
are deferred to a deterministic module; no swim boundaries are invented.

Evidence representations:

- `POWER_DURATION`: benchmark seconds, value watts; currently cycling-only.
- `DISTANCE_TIME`: benchmark meters, value elapsed seconds.

Source distinguishes measured/manual/estimated values, separately from PR status.
Missing capability entries have null scores, `INSUFFICIENT_EVIDENCE`, and `UNKNOWN`
trend. Populated capability estimates require evidence IDs, timestamps, and method
versions. The common score range is 0–100, but no scoring formula exists yet.

The context carries the latest 100 observations plus older observations cited by
the profile. It reports omitted history; all evidence remains in Postgres. This is
not an all-time best-effort curve. Evidence references must belong to the athlete;
cited observations later than the context timestamp are rejected.

### Races

Include races on or after the current local date, including those beyond the target
week. Independent importance scores are 0–100 with ties allowed. Stored demand
profiles contain version/source/generation metadata, explanation, and unique
sport/capability weights on a 0–100 scale. Weights do not sum to one and must include
a positive value. Demand sports must belong to the event. Missing demand profiles
remain null; no curated profiles or AI-generated demands are fabricated.

Race demands and athlete capabilities remain separate. Goal-relative strength,
adequate, and weakness assessments are deferred until a scoring policy exists.

### Availability, restrictions, and dates

`buildPlanningContext(userId, { now?, weekStart? })` defaults to next local Monday.
The optional date-only `weekStart` must be a Monday and can request the current week.
Week ends are exclusive. Restriction ends are inclusive; null means ongoing.

The builder returns seven target dates with `OVERRIDE`, `RECURRING`, or `UNCONFIGURED`
settings. Overrides replace the entire day's settings. Missing settings mean unknown,
not unlimited training. Pool access and allowed sports are separate facts, leaving
room for open-water swimming. Restrictions overlapping the target week are returned
separately; they do not change baseline fitness or mutate availability. Future
generation must enforce both restrictions and availability.

New summaries cover the current plus three complete **local** calendar weeks. The
builder maps real activity start instants to local date labels and reuses existing
numeric aggregation. Actual future instants are excluded before mapping. A conservative
query envelope covers timezone offsets, and local labels handle DST boundaries.
Legacy dashboard summaries remain UTC.

### Saved plans and protected workouts

The context returns current and target v1 plans, deduplicated if these are the same
week. Their original UTC dates are preserved, with an explicit compatibility note.
V1 plans are not converted into local-date plans by reading the context.

Workout state must identify an actual saved workout by date and template ID. Missing
metadata means unlocked/planned. Feedback supports comments and optional RPE 1–10.
The state write verifies ownership and the expected update timestamp under the
per-user training lock. The v1 generator now returns a conflict when replacement
would overwrite locked/completed/modified/stopped workouts. It cannot adapt around
them yet. Ordinary generation remains unchanged for existing empty metadata; replacing
unprotected workouts clears their old metadata.

This is deliberately a v1 bridge. Multiple workouts per day will need stable
workout IDs and a new plan format. Automatic activity linking, completion detection,
and the UI for locks/feedback are not implemented.

## Service boundary

`@pkg/db` exports these server-only operations:

```ts
saveAthleteProfile(userId, profile, timeZone)
createRaceGoal(userId, goal)
recordPerformanceEvidence(userId, observation)
saveWorkoutStates(userId, planId, expectedUpdatedAt, states)
buildPlanningContext(userId, { now, weekStart })
```

No new HTTP endpoints were added. Future route handlers must derive userId from
the authenticated session. These functions are storage boundaries, not authentication.

The builder reads within one `RepeatableRead` transaction (15-second timeout),
selects domain fields deliberately, and validates the result. It does not write,
call Strava/AI, or return raw streams, tokens, sessions, email, or DB credentials.
User comments remain untrusted text for a future prompt. A consistent DB snapshot
can still contain partial ingestion; failed/in-progress sync is flagged.

`now` controls temporal windows, not historical profile reconstruction. Profiles are
current records. Full profile revisions, generation leases, and stale-result handling
are not part of this increment.

## Verification

Completed: 10 new context tests, 27 deterministic-planner regressions, 9 training
summary tests, and 5 calendar tests (51 total); all workspace typechecks; web lint;
and the full worker/Next.js production build. Both migrations applied to the local
database, and Prisma reports no schema difference. The final eight-migration chain
also passed in a fresh disposable database. The original OAuth/sync suites were not
rerun in this increment; no provider calls or ingestion behavior were changed.

From the repository root:

```text
npm run db:generate
npm run db:deploy
npm run typecheck
npm run test:planning -- --example
npm run test:planner
npm run test:training
npm run test:calendar
npm run lint
npm run build
```

The new suite creates a disposable database, applies migrations, seeds fabricated
athletes, and cleans up afterward. `--example` writes only the seeded JSON artifact.
The Windows tsx loader needs to run outside this session's restricted sandbox to
resolve OS user information. The sandbox failure was environmental, not ignored.

## Review map

| File | Focus |
| --- | --- |
| [Prisma schema](../packages/db/prisma/schema.prisma) | JSON/relational choices and retention relations. |
| [Main migration](../packages/db/prisma/migrations/20260906000000_planning_context/migration.sql) | Additive defaults, constraints, and indexes. |
| [Index-name migration](../packages/db/prisma/migrations/20260906010000_evidence_index_name/migration.sql) | Stable PostgreSQL/Prisma index name. |
| [athlete-profile.ts](../packages/shared/src/athlete-profile.ts) | Units, evidence, zones, availability, restrictions, race demands, workout states. |
| [planning-dates.ts](../packages/shared/src/planning-dates.ts) | Real date validation and timezone conversion. |
| [Shared planning-context.ts](../packages/shared/src/planning-context.ts) | Output contract, missing data, saved snapshot/state checks. |
| [Database planning-context.ts](../packages/db/src/planning-context.ts) | Ownership, coherent reads, local aggregation, bounded evidence, serialization. |
| [Database planner.ts](../packages/db/src/planner.ts) | Protection against replacing locked/completed v1 workouts. |
| [Tests](../tests/planning-context.test.mjs) | Behavioral boundaries and example fixture. |

## Stop point and next step

- [x] Additive domain storage and shared schemas.
- [x] PostgreSQL context builder and readable seeded example.
- [x] Preserve deterministic planning and legacy reads.
- [ ] Configuration UI and production profile data entry.
- [ ] Derived zones, baseline estimation, performance extraction/scoring.
- [ ] Stream retention, matching, and goal-relative assessments.
- [ ] Structured AI workouts, provider calls, generation jobs, and adaptation.

Stop here for review. Recommended next increment: profile/race/availability forms
using the validated storage boundaries so real users can supply planning inputs.
Then define structured workout steps and deterministic target calculations before
adding the OpenAI call. The current deterministic planner still does not consume
the new availability and restriction settings.
