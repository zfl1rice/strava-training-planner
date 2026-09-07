# BlockReview decision-boundary evaluations

The [focus-identity follow-up](block-review-focus-identity.md) changes model entries to
ID/action/rationale and resolves their metadata on the server. Scenario evidence,
reference decisions, and the commands below remain unchanged.

September 7, 2026. All six requested boundaries reuse existing fixtures. Four have new canonical names with backward-compatible command aliases; no scenarios were duplicated. The suite still has 22 review scenarios. No BlockDecision/FocusAction contract, provider, model, planner prompt, persistence, or production behavior changed in this checkpoint.

## Audit and fixture changes

The common block has PRIMARY RUN/LONG_ENDURANCE/LONG_SESSION, SECONDARY BIKE/THRESHOLD/TIME_AT_INTENSITY, and MAINTENANCE SWIM/SUSTAINED_ENDURANCE/MAINTAIN. Unless noted otherwise, the reviewed week is week 2 of 4, DEVELOPMENT, with the next role DEVELOPMENT. The reviewed dates are September 7–13, and decisions apply September 14.

| Canonical scenario | Existing name | Evidence before this checkpoint | Changes made |
| --- | --- | --- | --- |
| `primary-success-secondary-poor` | `primary-progress-secondary-hold` | Reported completed runs at ordinary RPE; one bike session STOPPED at RPE 9; completed maintenance swims | Renamed; reference rationale explicitly distinguishes selective primary progress from secondary difficulty and acknowledges unknown execution |
| `high-rpe-hold` | `high-rpe` | All six workouts completed; one easy run at RPE 9 | Renamed; the comment identifies one unexplained difficult session while others felt ordinary; no illness, restriction, or repeated collapse added |
| `recover-early` | `poor-sessions-fatigue` | Two stopped runs at RPE 9 with reported fatigue | Renamed; adds a modified bike session at RPE 9 and several days of reported exhaustion, making the response materially stronger than one difficult workout |
| `continue-recovery` | Same | RECOVERY role and reported fatigue, but still full development-style duration and a hard bike prescription | Uses an explicitly reduced, all-easy 210-minute prescription; all six reported completed, but two short runs still have RPE 8/7 and persistent-fatigue comments |
| `complete-block` | Same | Final recovery boundary, also using development-style prescriptions | Uses the same reduced easy prescription, all completed at reported RPE 3; week 4/4 ends September 14, with no remaining pattern |
| `replan-new-race` | `new-important-race` | A newly added high-priority 10K on October 1 | Renamed; replaces the event with a September 20 800 m track race, importance 95, expected duration 120 seconds; records that the athlete entered it September 13 after the original no-race general-fitness block |

The reference global decisions and focus actions were already the intended ones and remain unchanged. Reference rationales were sharpened to match the evidence. A secondary HOLD rationale for recovery/terminal cases now reflects the global decision rather than implying ordinary development should continue.

The recovery fixture's 50% reduction is a deliberately chosen synthetic prescription, **not a new planner rule or universal recovery recommendation**. The new race is a manually specified scenario input; no race-demand generation was added.

## Reference outcomes and evidence

| Recommended order / scenario | Block decision | Run action | Bike action | Swim action | Resulting next-week behavior |
| --- | --- | --- | --- | --- | --- |
| 1. `primary-success-secondary-poor` | PROGRESS | PROGRESS | HOLD | MAINTAIN | Continue DEVELOPMENT with selective primary progression |
| 2. `high-rpe-hold` | HOLD | HOLD | HOLD | MAINTAIN | DEVELOPMENT with no deliberate focus progression |
| 3. `recover-early` | RECOVER_EARLY | HOLD | HOLD | MAINTAIN | Replace the next DEVELOPMENT role with RECOVERY |
| 4. `continue-recovery` | CONTINUE_RECOVERY | HOLD | HOLD | MAINTAIN | Keep the next role RECOVERY instead of calendar-driven resumption |
| 5. `complete-block` | COMPLETE_BLOCK | HOLD | HOLD | MAINTAIN | End the block; old guidance is historical; select/create the next strategy separately |
| 6. `replan-new-race` | REPLAN_BLOCK | HOLD | HOLD | MAINTAIN | Old strategy must be replaced before normal development continues |

All six boundaries intentionally use **reported response only**: activity rows are empty, linked recorded minutes remain null, and coverage is 0/2 for each sport. Unlinked background totals are zero because these fixtures supply no activity records; that is not proof that no training occurred. The separate partial/full linked fixtures continue testing actual linked calculations.

| Scenario | Planned minutes (run/bike/swim) | Reported-completed planned minutes (run/bike/swim) | Key completion/RPE distinction |
| --- | --- | --- | --- |
| `primary-success-secondary-poor` | 120 / 240 / 60 | 120 / 120 / 60 | Five completed; one stopped bike session at RPE 9; runs RPE 3 |
| `high-rpe-hold` | 120 / 240 / 60 | 120 / 240 / 60 | All completed; only one session at RPE 8+ |
| `recover-early` | 120 / 240 / 60 | 0 / 120 / 60 | Two stopped runs and one modified bike, all RPE 9 |
| `continue-recovery` | 60 / 120 / 30 | 60 / 120 / 30 | All completed; reduced easy runs still reported RPE 8 and 7 |
| `complete-block` | 60 / 120 / 30 | 60 / 120 / 30 | All completed at reported RPE 3; planned end reached |
| `replan-new-race` | 120 / 240 / 60 | 120 / 240 / 60 | Ordinary reported completion; strategic input change drives reassessment |

Reported-completed minutes are sums of prescribed durations attached to COMPLETED states. STOPPED and MODIFIED sessions do not contribute to that sum, which does not mean they involved zero exercise. No fixture claims measured recovery, fitness loss, medical conditions, or achieved power/pace. Reference answers are coaching comparisons, not required model text.

## Evaluator output and reference isolation

The compact summary now shows:

- Scenario, block week/count, current role, focus roles and progression strategies.
- Planned, reported-completed planned, linked recorded, and unlinked background minutes; coverage and reported session counts.
- Completion states and each workout's reported RPE/comment (long comments are shortened in the summary; JSON retains them).
- Model BlockDecision and focus guidance, followed by reference BlockDecision and focus guidance. Local runs are labeled **Simulated** rather than claiming a model ran.
- A non-authoritative MATCH/DIFFERENT/UNAVAILABLE comparison for the block decision and each sport/capability action.
- Effective next-week role or terminal replacement requirement, rationale, provider calls, latency, response model/ID, and token usage.

Full JSON remains available after the summary. Reference mismatches do not set an error exit status. Invalid provider output or lifecycle/domain violations still fail validation. A MATCH does not establish optimal coaching; a DIFFERENT result calls for reviewing the supplied evidence and rationale.

Reference decisions, guidance, and rationales remain outside the context passed to the reviewer. The existing local simulated reviewer deliberately returns the supplied reference for fixture validation. The live path receives only context and any correction information from its own earlier proposals. A mocked SDK test injects sentinel reference rationales, intercepts all six outgoing payloads, and confirms those references are absent. It returns a valid alternative HOLD for the first scenario and checks that the comparison is DIFFERENT while validation remains successful.

## Validation and changed files

| File | Responsibility in this checkpoint |
| --- | --- |
| [block-review-scenarios.mjs](../tests/fixtures/block-review-scenarios.mjs) | Reuses/renames six boundaries, retains four CLI aliases, adjusts evidence and reference rationales |
| [evaluate-block-reviews.mjs](../scripts/evaluate-block-reviews.mjs) | Adds result/reference summaries, non-authoritative comparison, per-workout evidence, next-role output, and alias selection |
| [block-reviews.test.mjs](../tests/block-reviews.test.mjs) | Six explicit fixture tests, CLI name/alias validation, six-request mocked reference-isolation/alternative-result test, invalid-result comparison test; retains evidence/lifecycle/concurrency coverage |
| This guide, MVP status, and code-review guide | Records exact commands, outcomes, audit findings, and review priorities |

The review suite now contains 31 tests (nine added). Tests independently check evidence totals, planned versus recorded distinction, roles, reference focus identity, recovery/terminal transitions, and the stronger evidence separating HOLD from RECOVER_EARLY. CLI tests invoke only the non-paid evaluator, including all six canonical names and four old aliases. No automatic test calls a live provider.

Full-check results are recorded in [MVP status](mvp-status.md): 233 tests, all 22 non-paid BlockReview scenarios, workspace TypeScript checks, lint, and production build. Existing weekly and strategic fixture evaluations were also checked. All application-record tests use isolated databases. No paid evaluation, deployment, commit, or push was performed.

## Manual paid commands, in recommended order

Run one command at a time from the repository root, then inspect its summary before proceeding. Each command may make up to three paid proposal calls. Existing worker OpenAI configuration is reused. No application records are written by the evaluator.

```powershell
npm run evaluate:block-review:openai -- --scenario primary-success-secondary-poor *> block-review-primary-success-secondary-poor.log
```

```powershell
npm run evaluate:block-review:openai -- --scenario high-rpe-hold *> block-review-high-rpe-hold.log
```

```powershell
npm run evaluate:block-review:openai -- --scenario recover-early *> block-review-recover-early.log
```

```powershell
npm run evaluate:block-review:openai -- --scenario continue-recovery *> block-review-continue-recovery.log
```

```powershell
npm run evaluate:block-review:openai -- --scenario complete-block *> block-review-complete-block.log
```

```powershell
npm run evaluate:block-review:openai -- --scenario replan-new-race *> block-review-replan-new-race.log
```

These commands were **not run** during implementation. To exercise any selection without a paid call, use `npm run evaluate:block-review -- --scenario <name>` instead. The older `primary-progress-secondary-hold`, `high-rpe`, `poor-sessions-fatigue`, and `new-important-race` command names select the corresponding canonical fixture, so previous instructions still work without duplicate scenarios.
