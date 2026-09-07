# Percentage-target and evaluator audit

September 7, 2026. This fixes the live evaluation's `0.88` FTP target being
interpreted as 0.88%, resolving to 2.20 W and corrupting effort classification.
Existing uncommitted development-block work was preserved. No model, provider,
coaching policy, database schema, or resolver formula was replaced.

## Canonical units

| Actual metric | Baseline and absolute result | Percentage convention |
| --- | --- | --- |
| `FTP_PERCENT` | Cycling FTP; watts | 88–92 with FTP 250 W gives **220–230 W** |
| `MAX_HR_PERCENT` | Running max HR; BPM | 80–90 with max HR 190 gives **152–171 BPM** |
| `THRESHOLD_PACE_PERCENT`, RUN | Running threshold pace; seconds/km | 110–120 with 300 s/km gives **330–360 s/km** |
| `THRESHOLD_PACE_PERCENT`, SWIM | Swimming threshold pace; seconds/100 m or seconds/100 yd | 110–120 with baseline 100 gives **110–120** in that baseline's pace unit |

There are no separate `RUN_THRESHOLD_PACE_PERCENT` or
`SWIM_THRESHOLD_PACE_PERCENT` enums. Both use `THRESHOLD_PACE_PERCENT`, with sport
selecting the baseline/unit. Higher pace percentages mean **slower** because they
scale time per distance, not speed. `RPE` is a separate non-percentage scale.

All existing percent target math uses `baseline * percentagePoints / 100` with
two-decimal rounding. Generated templates already used numbers such as 45, 60,
110, and 125. Existing tests used FTP 100–110 and pace 110–120. Effort classification
compares FTP targets against 75/90 and max HR against 75/85, confirming the same
percentage-point convention. No inconsistency between target metrics was found.
Volume/intensity adjustment settings also use percentage points, but they are
separate settings and were not changed by this target-unit guard.

## Where the convention is enforced

`WorkoutTargetSchema` in `structured-workouts.ts` defines the target representation.
`WorkoutSegmentSchema`, structured workouts, proposals, and stored v2 plans reuse
it. The finalizer validates proposals before calculating effort/resolved targets
and before persistence. `resolveWorkoutTargets` and `workoutEffort` also validate
targets when called directly, so typed-but-malformed objects cannot bypass this
check. Display descriptions/charts already expect percentage points.

The shared schema now rejects **either percent bound in `(0, 2]`** as likely
fractional encoding, returning a custom issue tagged `LIKELY_FRACTIONAL_PERCENTAGE`.
The finalizer preserves that code, the nested bound path, and the workout ID in
the existing `ProposalValidationError`. Nothing is multiplied by 100 automatically.

Example correction feedback:

```text
LIKELY_FRACTIONAL_PERCENTAGE
workout: quality-target
path: workouts.0.blocks.0.segments.0.target.lower
FTP_PERCENT uses percentage points: use 88 for 88%, not 0.88.
```

This reserves the ambiguous interval rather than imposing a physiological floor
such as 40% FTP. **2.01 and 10 remain valid percentage points**. A literal target
of 1% is also rejected under this representation guard; the server cannot infer
whether the author meant 1% or 100%. Zero/negative/nonfinite targets remain invalid
under the existing positive-number rule. Existing maxima remain 100 for max HR,
300 for FTP/threshold pace, and 10 for RPE. FTP 105–110 remains valid.

No old log or saved plan was silently repaired. Previously saved malformed targets
will fail validation rather than be reinterpreted; correcting such records requires
explicit intent. The reported live evaluator does not itself persist its plans.

## Prompt and wire schema

The stable prompt adds this rule once:

> All *_PERCENT targets use percentage points: 88 means 88%; never encode 88% as 0.88.

The existing explanation that higher pace percentages mean slower remains in place.
Shared schema descriptions also state the units for the metric and numeric bounds.
The OpenAI wire schema continues to derive from the shared shape and carries those
descriptions. Its stripped cross-field refinements remain authoritative in the
application finalizer, not solely in the model prompt. The existing
[Structured Outputs integration](https://developers.openai.com/api/docs/guides/structured-outputs)
is retained; no new provider implementation was introduced.

## Failed attempt visibility

`generatePlanWithCorrections` exposes an optional `reportValidation` observer after
each finalized or rejected proposal. It receives the existing structured issues;
it does not alter retries, add a second validator, or create another storage layer.
The evaluator collects these into `attempts` in its JSON result:

```text
Attempt 1: INVALID
  LIKELY_FRACTIONAL_PERCENTAGE | workout: quality-target | path: workouts.0.blocks.0.segments.0.target.lower | ...
Attempt 2: VALID
```

All rejected attempts, including the third exhausted attempt, remain visible.
An attempt that failed at the provider before a proposal could be validated is
`NOT_VALIDATED`, with its error category. Console output shows at most ten issues
per attempt; additional issues remain in JSON. Duplicate proposal bodies are not
added to the summary. Existing scenario/model, calls, latency, response IDs, token
usage, cached input, and final validity reporting remain intact. The summary does
not print credentials or full athlete context.

## DevelopmentBlock audit

The original **`general-fitness` scenario has no active block**. It remains useful
for backwards-compatible weekly planning, and its summary now explicitly says so.
The earlier isolated-week appearance was not simply a hidden block header.

The new **`general-fitness-active-block`** scenario supplies:

| Field | Value |
| --- | --- |
| Objective | GENERAL_FITNESS; no races |
| Phase | GENERAL_PREPARATION |
| Position | Week 2 of 4 (`weekIndex: 1`) |
| Role | DEVELOPMENT |
| Primary | RUN / LONG_ENDURANCE; LONG_SESSION progression |
| Secondary | BIKE / THRESHOLD; TIME_AT_INTENSITY progression |
| Maintenance | SWIM / SUSTAINED_ENDURANCE; MAINTAIN |
| Response evidence | Explicit synthetic feedback describing comfortable completion and interest in a small long-run progression |
| Desired weekly goals | RUN 120, BIKE 240, SWIM 60 minutes |

The fixture constructs a validated block and obtains its weekly projection with
`activeBlockForWeek`. It enters `GenerationInput.context.developmentBlock` and
`seasonPhase`, then `buildOpenAIPlanningInput` serializes it in the actual SDK
request. A mocked SDK regression asserts that payload. The server retains the
same strategy in the resulting plan's provenance. The evaluator's compact header
prints phase, position, role, each focus, and progression strategy before the plan.

Existing weekly instructions already distinguish primary/secondary/maintenance,
development/recovery/taper/return, contextual progression, and preservation of block
focus. They already say not to progress every variable together and not to treat
minimum effective dose as always less. These coaching rules were not strengthened
or redesigned here. Hard/soft goal and clustering policies are unchanged.

## Tests and checks

Seven added tests cover:

1. Fractional bounds, zero/nonfinite values, low valid percentages, above-FTP targets,
   and unchanged RPE/max-HR limits.
2. Absolute resolution of watts, BPM, running pace, and both swim pace units;
   direct resolver/classifier rejection of malformed input.
3. Structured issue paths/workout IDs, unchanged malformed input, and a valid
   88–92% FTP quality session classified HARD and counted in hard-session analysis.
4. Schema descriptions and an SDK-mocked fractional-first/corrected-second proposal,
   including actionable correction feedback and displayed attempt results.
5. All three invalid attempts and provider-before-validation failure visibility.
6. Failed unit proposals cannot overwrite an existing stored plan.
7. The no-block and active-block fixtures, actual SDK payload, strategy header,
   and saved block provenance.

The existing evaluator-summary test now also checks invalid/valid attempt reporting.
The free-scenario coverage count increases from 20 to 21.

Validation: **202 tests**, **21 free weekly scenarios**, **18 free block fixtures**,
workspace typechecks, lint, and production build. Integration tests use disposable
databases and mocked OpenAI transport. No paid calls or live Strava requests.

## Files changed for this fix

| File | Change |
| --- | --- |
| [structured-workouts.ts](../packages/shared/src/structured-workouts.ts) | Shared unit descriptions and fractional-encoding guard |
| [workout-targets.ts](../packages/shared/src/workout-targets.ts) | Validate direct resolution/classification calls; document unchanged math |
| [plan-generation.ts](../packages/shared/src/plan-generation.ts) | Preserve actionable schema issue codes/IDs and report per-attempt validity |
| [planner-prompt.ts](../apps/worker/src/planner-prompt.ts) | One percentage-point instruction |
| [evaluate-planner.mjs](../scripts/evaluate-planner.mjs) | Attempt summaries and compact strategy header/JSON metadata |
| [planning-scenarios.mjs](../tests/fixtures/planning-scenarios.mjs) | Separate active-block general-fitness fixture |
| [openai-planner.test.mjs](../tests/openai-planner.test.mjs) | Unit, resolver, effort, correction, persistence, and evaluator regressions |
| [planning-semantics.test.mjs](../tests/planning-semantics.test.mjs) | Updated fixture count |
| This guide, [OpenAI guide](openai-planner.md), [review guide](code-review.md), [status](mvp-status.md) | Audit, commands, and review entry points |

## One manual paid evaluation after review

Run this from the repository root; it selects **one active-block scenario**, with
up to three paid proposal calls through the existing correction limit:

```powershell
npm run evaluate:planner:openai -- --scenario general-fitness-active-block *> general-fitness-active-block.log
```

Then open `general-fitness-active-block.log` in the editor. First verify the strategy
header and attempt errors. Check that target numbers are percentage points, then
review whether the week actually develops the primary run emphasis, gives useful
secondary bike work, and maintains swimming. Assess progression against the supplied
response and history while retaining the desired weekly goals. A structural PASS
does **not** establish coaching quality or prove that the block was executed well.

The command above was not run during implementation. For a free check, use
`npm run evaluate:planner -- --scenario general-fitness-active-block`.
