# Pre-AI integration checklist

Each step is validated and committed separately. No model calls or AI credentials
are introduced by this sequence.

- [x] Expand the workout format: v2 custom workouts, stable IDs, repeated interval
  blocks, intensity targets, multiple sessions per date, compatible v1 reads.
- [ ] Replace fixed scheduling
- [ ] Resolve workout targets
- [ ] Add feedback and adjustment controls
- [ ] Implement regeneration boundaries
- [ ] Prepare background generation
- [ ] Finalize the AI input/output contract

V2 week timestamps encode local calendar labels at UTC midnight; they are not
scheduled start instants. Each plan records its timezone. Old v1 snapshots retain
their UTC interpretation. Custom interval duration must exactly match its blocks;
IDs must be unique, and each date contains workouts or one rest entry.
