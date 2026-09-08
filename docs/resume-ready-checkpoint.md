# Resume-ready application checkpoint

Implementation connects the existing prototype pieces without changing the web/worker architecture. **Live credential verification remains manual:** this checkout has no OpenAI API key, and no paid model call or real OAuth approval was performed during this checkpoint. The real application path passes integration tests with mocked OpenAI transport.

## Current flow

1. Strava-authenticated web endpoints load the athlete from an opaque session cookie.
2. Goals/profile/availability/races persist through existing DB services.
3. First UI generation creates a deterministic starter DevelopmentBlock if none exists, including for General Fitness. A small panel also creates/replaces blocks explicitly.
4. Generation persists a JobRun, enqueues its ID, and the separate worker selects the configured provider.
5. OpenAI proposals pass the existing correction loop and deterministic checks. Snapshot/lease checks protect the final save. Failure retains the previous plan.
6. Planner polling updates the saved plan and refreshes calendar data. Cards show sport/title/duration/effort/completion; details show grouped repeats and relative/resolved targets.
7. Existing feedback endpoints persist completion, RPE, comments, and protection state.
8. Review Week saves a frozen review request and enqueues its ID. The worker invokes the OpenAI reviewer, validates focus IDs/lifecycle, then atomically appends the review and marks the job successful.
9. The panel polls pending reviews and shows global decision, per-focus guidance, rationale and effective week. Subsequent generation receives the persisted guidance. Terminal decisions close the block; next generation creates a successor or the user can create one explicitly.

Requests are serialized per athlete across sync, weekly generation, and review. Settings/feedback edits remain possible; stale results are cancelled instead of overwriting newer inputs. Direct simulated review helpers remain available for tests; application live review uses durable dispatch.

## Verification

| Check | Result |
| --- | --- |
| Full non-paid suite | 252 tests across 15 suites |
| New application integration suite | 14 tests, including authenticated routes → real Redis/BullMQ → worker → mocked OpenAI → Postgres → calendar, plus feedback → review |
| Existing Strava coverage | 13 OAuth and 28 ingestion tests included in the full suite |
| Free weekly fixtures | 21/21 valid |
| Free strategic block fixtures | 18/18 valid |
| Free review fixtures | 22/22 valid |
| TypeScript, lint, production build | Passed; production includes static `/demo` and dynamic authenticated APIs |
| Browser smoke | Headless Edge; opens workout dialog, verifies repeats/resolved watts, read-only controls and mobile containment; synthetic screenshots produced |
| Database migration | Additive review-job migration applied to local application DB and tested in disposable DBs |
| Local configuration | Matching web/worker Postgres and Redis settings; Redis PING and schema checks pass |
| Live OpenAI UI run | Pending: supply worker API key and perform manual smoke steps |
| Live Strava browser approval | User must verify with own account; mocked integration tests pass |
| Public deployment | Not performed |

The worker local file was created only because it was absent: `PLANNER_PROVIDER=openai` with a blank key. It is ignored by Git. No private key was copied into web. Existing application data was not seeded or replaced; only the additive schema migration was applied. All test records use isolated disposable databases/queues.

## Files and review priorities

Paths below are relative to the repository root. Review job ownership and strategy defaults first.

| File(s) | Implements / what to review |
| --- | --- |
| `packages/db/src/review-jobs.ts` | **Highest priority:** frozen review requests, deduplication, attempt claims, leases/heartbeat, provider-call/proposal persistence, bounded retries, stale checks and atomic review completion |
| `packages/db/src/training-block-state.ts` | **Highest priority:** starter General Fitness/race strategy using explicit data, replacement, owned block/review state and eligible review weeks |
| `packages/shared/src/training-block-state.ts` | Shared persisted review request schema, request validation and UI state type |
| `packages/shared/src/jobSchemas.ts`, `queue.ts` | Strict ID-only ReviewBlockJob and review queue name/ID |
| `packages/db/prisma/schema.prisma`, `prisma/migrations/20260908000000_review_jobs/migration.sql` | REVIEW_BLOCK job type and reviewRequest JSON column; no rewrite of existing reviews |
| `packages/db/src/development-blocks.ts` | Prevent block replacement during an active review; typed busy error for sync; retain weekly-job invalidation on block edits |
| `packages/db/src/block-reviews.ts` | Clarify direct simulated helper versus durable application review |
| `packages/db/src/plan-jobs.ts`, `activities.ts` | Cross-operation busy guards; recovery queries support review jobs |
| `packages/db/src/index.ts`, `packages/shared/src/index.ts` | Export the new application contracts/services |
| `apps/worker/src/review-provider.ts` | Lazy worker-only OpenAI reviewer configuration; useful missing-key/provider failure |
| `apps/worker/src/processor.ts` | Validates/dispatches review jobs through the existing worker |
| `apps/worker/src/plan-recovery.ts` | Existing recovery scan now handles review IDs and the correct job type |
| `apps/worker/src/block-reviewer.ts` | Existing SDK adapter reused unchanged; updated scope comment |
| `apps/web/src/app/api/training-block/route.ts` | Session/origin checks, block actions, persistent review dispatch and polling |
| `apps/web/src/app/api/planner/route.ts` | Create missing starter strategy before the existing generation request |
| `apps/web/src/lib/queue.ts` | Reuse queue connection for identically shaped generation/review payloads |
| `apps/web/src/app/training-block-panel.tsx` | Block summary, create/replace, week selection, review polling, errors and guidance |
| `apps/web/src/app/activity-dashboard.tsx` | Mount block/review panel beside existing calendar/planner |
| `apps/web/src/app/weekly-planner.tsx` | Clear provider/configuration copy, provenance, persisted failure display, immediate-success refresh |
| `apps/web/src/app/training-calendar.tsx` | Saved completion labels, green reported completion, demo isolation, structured details, deterministic demo date |
| `apps/web/src/app/structured-workout-details.tsx` | Group repeat blocks; show work/recovery instructions and resolved targets |
| `apps/web/src/app/workout-chart.tsx` | Target colors use existing effort classification; single-string SVG title fixes React hydration |
| `apps/web/src/app/page.tsx`, `app-navigation.tsx` | Landing explanation and demo entry point |
| `apps/web/src/app/demo/page.tsx`, `demo/sample.json` | Public static synthetic demo using actual calendar/detail/block components; no athlete session or DB seed |
| `apps/web/next.config.ts` | Monorepo dependency tracing for deployment |
| `scripts/build-demo.mjs` | Rebuilds only the synthetic fixture with existing schemas/validator; zero database/API calls |
| `scripts/screenshot-demo.mjs` | Optional installed-Edge/Chromium local browser smoke and synthetic screenshot capture |
| `scripts/check-local.mjs` | Secret-free configuration, Postgres migration and Redis read-only checks |
| `scripts/test-all.mjs`, `scripts/test-strava.mjs`, `package.json` | Full suite runner, new suite entry, separate deployable build commands and local checks |
| `tests/review-jobs.test.mjs` | Review lifecycle/retries/ownership/staleness/recovery; route-to-worker mocked OpenAI integration; demo contract checks |
| `docs/screenshots/*.png` | Synthetic calendar, detail, review and mobile captures |
| `README.md` | Recruiter overview, architecture, rationale, setup, test and demo commands |
| `docs/resume-readiness-audit.md` | Before-change audit |
| `docs/local-product-smoke.md` | Exact startup, manual paid/live verification and screenshot checklist |
| `docs/deployment.md` | Vercel web + hosted data + local worker preparation; no deployment claimed |
| `docs/mvp-status.md`, `design.md`, `code-review.md`, `adaptive-block-reviews.md`, `development-blocks.md`, `openai-planner.md` | Current checkpoint links; older sections remain historical |

## Remaining limits

- No OpenAI key is available in this checkout. Live weekly/review behavior must be confirmed manually after setup. A passing mocked SDK test does not establish model availability, account permissions or coaching quality.
- Starter block selection is deterministic and deliberately simple. It uses explicit race priority/demands/duration and a short race-week pattern; it is not an inferred strength/weakness engine or optimized season plan.
- Review covers the current or immediately preceding saved week within the active block. In-progress reviews are labeled; older arbitrary historical reviews are not added here.
- No automatic activity/workout matching or interval target verification. Reported completion and background activity totals stay separate.
- Existing workouts change on generation, not merely when a review completes. Protected workouts remain protected.
- Personal/small-group Strava sessions remain the authentication model. No broad multi-user service or public AI spending controls were added.
- A local worker must stay running. Queue recovery is durable, but a provider call can be repeated after a crash before its response is persisted.
- Demo examples are hand-authored and synthetic. They do not claim paid AI provenance, real usage scale, race outcomes or measured fitness improvement.

## Next actions

Startup and the exact manual end-to-end sequence are in [local-product-smoke.md](local-product-smoke.md). Supply the worker key, restart `npm run dev`, then perform one UI generation and one eligible Review Week action. Those are paid actions for the user to run, not automated by this checkpoint.

For public deployment, provision hosted Postgres/TCP Redis, apply migrations, configure the local worker, then explicitly import/deploy the web app using [deployment.md](deployment.md). Add the resulting `/demo` URL to README/portfolio after verifying it without a session.

Suggested truthful resume bullets (choose those that fit):

- Built a Next.js and TypeScript triathlon planner with a separate Redis/BullMQ worker for asynchronous Strava ingestion and structured AI planning.
- Implemented idempotent activity upserts and durable planning/review jobs with bounded retries, leases, and stale-result protection in PostgreSQL.
- Integrated structured workout generation and adaptive training-block reviews with deterministic validation, per-focus guidance, and an interactive training calendar.
- Validated planning and ingestion behavior with 252 automated tests and 61 non-paid scenario fixtures, including real Redis/Postgres integration with mocked AI responses.

Do not claim public deployment, production user volume, or live end-to-end credential verification until those actions have been completed and measured.
