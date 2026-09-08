> Historical milestone / design record. For current behavior and setup, start with the [documentation index](README.md) and [architecture](architecture.md).

# Product vision and implementation scope

Recorded from the user's product direction on September 5, 2026.

The product removes the mental work of organizing triathlon training. It should
eventually turn race goals, training history, and real-life availability into an
adaptive weekly schedule and keep that schedule organized for the athlete.
For example, an athlete targeting a 70.3 in four months supplies availability and
constraints, connects Strava, and receives a suitable training week that can evolve
as training is completed.

The intended long-term flow is:

Race goal + athlete constraints + Strava history + availability → training analysis
→ plan generation → scheduling → Google Calendar → completed activities from Strava
→ future plan adaptation.

## Current pre-AI MVP

Implement the smallest working vertical slices in this order, reusing completed work:

1. Typed web → BullMQ/Redis → worker Ping path.
2. Strava OAuth, persisted athlete/tokens, and refresh.
3. Asynchronous ingestion with unique Strava activity IDs, idempotent upserts,
   retries, and backoff.
4. Connection status, sync button, recent activities, and last successful sync.
5. Structured athlete/race profile: race type/date, weekly available training time,
   preferred rest day, preferred/available swim/bike/run days, experience level,
   and basic scheduling constraints.
6. Per-sport weekly duration/distance, total time, and recent 4–6 week volume.
   Longest recent sessions are optional if useful; avoid physiological modeling.
7. Structured swim/bike/run templates with sport, workout type, duration range,
   intensity, and applicable phase. Candidate types include easy/long/tempo/interval/
   brick runs, recovery/endurance/tempo/threshold/long rides, and recovery/technique/
   endurance/threshold swims. These are a direction for the template vocabulary,
   not a requirement to assign every workout type to every athlete.
8. A deterministic, testable planner using race information, time until race,
   availability, recent volume, templates, and simple scheduling/training constraints.
9. Display the generated week in the web app. Stop the current MVP here.

The [MVP checklist](mvp-status.md) records actual completion. The existing planner
uses recent volume, optional sport time goals, and a fixed easy-workout schedule.
Profile inputs and planning against availability remain to be implemented. Weekly
sport goals do not yet express an athlete's overall available time or available days.

## Boundaries to preserve

- Keep the npm monorepo: Next.js/TypeScript web, BullMQ worker, Prisma/Postgres db
  package, and shared schemas/types/domain logic package.
- Web and worker remain separate deployables and never import one another.
- Communicate through BullMQ, keep job payloads small, access the database through
  `packages/db`, and treat Postgres as the source of truth.
- Preserve working code, make small changes, avoid unnecessary abstractions and
  services, and explain any necessary architectural change before implementing it.
- Validate meaningful changes with relevant tests/typechecks/builds and maintain
  the checklist. Continue reviewing design decisions one at a time with the user.

Plan generation decides which workouts belong in a week. Scheduling decides where
they fit in available days/times. Keep these concepts distinct as availability is
introduced, without adding a service or rewriting the working planner prematurely.

## Deferred direction

Do not implement LLMs, Google Calendar, an adaptive feedback loop, advanced
pace/power/heart-rate models, TSS/CTL/ATL, elaborate periodization, a template editor,
advanced observability, elaborate UI polish, multi-user scaling, or unnecessary
performance optimization for this MVP.

Later, an LLM may select from allowed templates using summaries, race goals, and
availability. Its structured output must pass schema and training/scheduling
validation, with a deterministic fallback. It should operate inside the planning
system rather than replace it.

Later scheduling can incorporate Calendar availability and export. Later adaptation
can compare planned and completed activities, update training state, and adjust
future weeks using adherence, volume progression, performance trends, missed
workouts, and discipline weaknesses. These remain future capabilities.
