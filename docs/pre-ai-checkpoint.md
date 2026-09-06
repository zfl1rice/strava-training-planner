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
- [ ] Finalize the AI input/output contract

V2 week timestamps encode local calendar labels at UTC midnight; they are not
scheduled start instants. Each plan records its timezone. Old v1 snapshots retain
their UTC interpretation. Custom interval duration must exactly match its blocks;
IDs must be unique, and each date contains workouts or one rest entry.
