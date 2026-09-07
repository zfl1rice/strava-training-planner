# BlockReview focus identity

September 7, 2026 structural follow-up to the live `continue-recovery` failure. The reviewer now selects actions using server-provided focus IDs. Server code resolves all authoritative focus metadata. Coaching decisions, evidence semantics, providers/models, and the maximum of three proposal attempts are unchanged. No paid calls were made.

## Audit

| Item | Previous behavior and finding |
| --- | --- |
| DevelopmentFocus | Immutable proposal entries contain sport, capability, role, progression strategy, and rationale. |
| Persistent IDs | Focuses have no independent database ID. The block has an ID and optimistic revision; its proposal is immutable. |
| Existing stable key | Uniqueness and matching already used `${sport}:${capability}` within the block. Duplicate sport/capability pairs are prohibited. |
| Review input | `BlockReviewContext` contains the active block and its authoritative focuses, captured evidence, goals/objective, future roles, and an internal freshness fingerprint. |
| Review output | Each guidance item repeated sport/capability plus action/rationale. |
| Validator | Matched repeated sport/capability values and returned a generic whole-array coverage error; existing maintenance/recovery/progression checks followed. |
| OpenAI schema | Required arbitrary sport/capability values in each item, with an array length of 1–12. It did not constrain identity to this block's exact focus set. |
| Corrections | The existing three-attempt loop supplied validation errors and the previous proposal, but no explicit allowed-ID list. |
| Persistence | Guidance lived in `review.request.focusGuidance` JSON, with append-only review revisions and no separate focus table. |
| Evaluator | Compared and displayed result/reference guidance by repeated sport/capability fields. |

The supplied log confirms three repeated coverage failures. It does not include the offending raw guidance entries, so it does not establish which exact identity was mistyped, omitted, or duplicated. The fix removes the need to reproduce those metadata fields and improves diagnostics for any remaining ID coverage error.

## Identity strategy and model contract

`developmentFocusId(focus)` reuses the existing deterministic key:

```text
RUN:LONG_ENDURANCE
BIKE:THRESHOLD
SWIM:SUSTAINED_ENDURANCE
```

These IDs are **scoped to the parent block**, not globally unique records. They do not depend on array order, rationale, week role/index, or review revision. The immutable block proposal and existing block ID/revision checks supply ownership and freshness. A different block may use the same sport/capability key; reviews remain tied to their own parent block.

The model-facing projection adds the ID to each authoritative input focus:

```json
{
  "focusId": "RUN:LONG_ENDURANCE",
  "sport": "RUN",
  "capability": "LONG_ENDURANCE",
  "role": "PRIMARY",
  "progressionStrategy": "LONG_SESSION",
  "rationale": "The existing block's strategic explanation."
}
```

The internal block proposal and database schema do not need a new field. The OpenAI input projection computes IDs; shared validation and simulated fixtures use the same function.

The output now has only ID, action, and rationale per focus:

```json
{
  "decision": "CONTINUE_RECOVERY",
  "rationale": "The supplied response supports continuing recovery.",
  "focusGuidance": [
    { "focusId": "RUN:LONG_ENDURANCE", "action": "HOLD", "rationale": "Preserve the focus without progressing during recovery." },
    { "focusId": "BIKE:THRESHOLD", "action": "HOLD", "rationale": "No development progression during the recovery week." },
    { "focusId": "SWIM:SUSTAINED_ENDURANCE", "action": "MAINTAIN", "rationale": "Retain useful maintenance exposure within recovery needs." }
  ]
}
```

This example illustrates the shape; it is not a hardcoded live answer. Per-focus sport, capability, role, progression strategy, and workout prescriptions are rejected as extra model output fields. Existing rationale limits remain in force.

## Validation and correction

The OpenAI Structured Outputs schema is constructed from the captured block's allowed focus IDs. `focusId` is an enum of exactly that set; the guidance array length equals the focus count. Deterministic validation still checks coverage because an enum and fixed array length alone do not prevent duplicate IDs.

Validation requires exactly one entry per active focus. Missing, unknown, duplicate, and extra IDs are rejected. The server resolves each ID against the authoritative block and then applies the unchanged coaching/lifecycle rules. Global PROGRESS still requires at least one focus progression; maintenance stays MAINTAIN; recovery and terminal decisions cannot authorize focus progression. Multiple justified progressions and the existing narrowly justified HOLD exception remain possible.

Coverage errors name missing/unknown/duplicate IDs and list the exact allowed set. Schema errors also include allowed-ID guidance. Correction input includes:

```text
errors: existing structured validation errors
allowedFocusIds: exact IDs from the captured block
instructions: return exactly one item per ID; do not rename/omit/duplicate/create IDs
previousProposal: the model's previous proposal
```

The existing three-attempt loop handles correction. No new retry loop or provider stack was added. Reference outcomes remain outside model input.

## Persistence and weekly planning

Server-resolved guidance is stored with the existing review request JSON:

```json
{
  "focusId": "RUN:LONG_ENDURANCE",
  "sport": "RUN",
  "capability": "LONG_ENDURANCE",
  "role": "PRIMARY",
  "progressionStrategy": "LONG_SESSION",
  "action": "HOLD",
  "rationale": "The review's concise explanation."
}
```

Authoritative matching uses `focusId`; metadata is a snapshot for history and display. New writes validate any supplied resolved metadata against the immutable block, rejecting discrepancies rather than accepting identity changes. New review-service writes use source version `block-review-v3`. Evidence remains version 2 with the same planned/reported/recorded meanings.

**No migration is needed.** Existing JSON columns store the new fields. Persisted legacy sport/capability guidance and reviews with no guidance remain readable. Historical rows are not rewritten. When legacy guidance is projected into a weekly context, the server derives its ID and resolves the full metadata from its immutable parent block. New writes through the older administrative review path also normalize supplied guidance to the resolved representation.

`developmentBlock.previousReview.request.focusGuidance` continues to carry the latest applicable guidance into weekly planning, now including focus ID, sport, capability, role, progression strategy, action, and rationale. The weekly planner does not resolve IDs itself. The existing compact projection still omits detailed review evidence; no extra historical reviews are added to the weekly prompt.

Review revisions, transaction boundaries, stale snapshot rejection, protected workout history, future-role overrides, and terminal-block gates remain unchanged. Production live-review dispatch is still deferred.

## Evaluator and fixture behavior

Fixtures now express reference proposals using IDs without altering their evidence or reference coaching outcomes. The evaluator resolves reference IDs and model-result IDs through the same authoritative metadata. Comparisons use IDs, while the human summary still shows:

```text
PRIMARY RUN / LONG_ENDURANCE -> HOLD
SECONDARY BIKE / THRESHOLD -> HOLD
MAINTENANCE SWIM / SUSTAINED_ENDURANCE -> MAINTAIN
```

The raw `proposal` JSON shows model-facing ID entries; the validated `request` JSON shows full resolved guidance. Reference mismatches remain visible but non-authoritative. Invalid structure/domain results still fail. All six boundary names and their old command aliases are preserved.

## Files to review

| File | Change / review focus |
| --- | --- |
| [development-block.ts](../packages/shared/src/development-block.ts) | **Start here:** deterministic ID function, model-reference versus legacy/resolved schemas, authoritative resolution, identity/metadata validation, weekly legacy projection |
| [block-review.ts](../packages/shared/src/block-review.ts) | Strict ID-only proposal entries, exact allowed-ID diagnostics, reconstruction before creating a persistence request |
| [block-review-evidence.ts](../packages/shared/src/block-review-evidence.ts) | Accepts the new source version; no evidence calculation changes |
| [development-blocks.ts](../packages/db/src/development-blocks.ts) | Normalizes new review writes to resolved guidance after ownership/revision checks |
| [block-reviews.ts](../packages/db/src/block-reviews.ts) | Records source `block-review-v3`; snapshot/compare/commit flow unchanged |
| [block-reviewer.ts](../apps/worker/src/block-reviewer.ts) | Adds input IDs, exact enum/count Structured Outputs schema, structural prompt wording, explicit correction ID list |
| [evaluate-block-reviews.mjs](../scripts/evaluate-block-reviews.mjs) | ID comparisons and server-resolved human display |
| [block-review-scenarios.mjs](../tests/fixtures/block-review-scenarios.mjs) | ID-only reference proposals; no coaching/evidence changes |
| [block-reviews.test.mjs](../tests/block-reviews.test.mjs) | New identity, correction, metadata tampering, persistence, weekly handoff, and legacy-history tests; existing boundary/stale tests retained |
| This guide, earlier review guides, MVP status, code-review guide | Current schema examples, audit, validation status, and manual rerun instructions |

## Validation and manual rerun

The focused review suite has 36 tests, including five new identity-focused cases. They cover valid reordered IDs, missing/unknown/duplicate/extra IDs, forbidden metadata output, resolved metadata, persistence, historical compatibility, weekly delivery, and readable evaluation. A mocked `continue-recovery` run returns a wrong ID, then an omitted ID, then a valid result; correction succeeds within the existing three attempts. A separate invalid-proposal check confirms exhaustion still stops at three.

The full checkpoint validation is recorded in [MVP status](mvp-status.md): 238 tests, all 22 non-paid review scenarios, existing weekly/strategic scenarios, TypeScript checks, lint, and production build. Database tests use disposable isolated databases. No test made a live OpenAI call, and no real athlete review was created.

Rerun only this paid scenario manually from the repository root:

```powershell
npm run evaluate:block-review:openai -- --scenario continue-recovery
```

For a PowerShell log:

```powershell
npm run evaluate:block-review:openai -- --scenario continue-recovery *> block-review-continue-recovery.log
```

The reference remains CONTINUE_RECOVERY with run HOLD, bike HOLD, swim MAINTAIN, and the next role RECOVERY. That live command was **not run** during this task. The live model's behavior still needs that manual check; passing mocked/fixture tests establishes structural handling, not live coaching quality.
