# Portfolio presentation audit

This checkpoint changes documentation, screenshot capture and ignore rules. It does not add application features, alter planning architecture or deploy a service.

## Audit findings

The prior README correctly described process separation, durable jobs and the proposal-provider boundary. It included real synthetic screenshots and reproducible local/test commands, and did not claim production deployment.

The opening was long and its full-height screenshot crowded out the key capabilities. Demo navigation included broken separator characters and placeholder deployment copy. Current sport-focus controls and safe week clearing were missing. “Three correction attempts” was ambiguous: code permits three **total proposals**, including the first. General Fitness selection was described only as rotation despite newer saved-emphasis support. The linked integration checkpoint reported an older 252-test milestone rather than the current 268-test checkpoint.

Historical docs mixed several “current” addenda with outdated statements that AI, async generation or live review dispatch did not exist. They are retained as engineering history with prominent current-entry-point links. The current README and architecture guide are the starting point. No useful source or historical verification record was deleted.

## Claim-to-code audit

| Published claim | Evidence / boundary |
| --- | --- |
| Separate web and background worker | Workspace manifests, independent dev/build/start scripts, no cross-app imports |
| PostgreSQL source of truth; ID-only domain jobs | `packages/shared/src/jobSchemas.ts`, `packages/db/src/plan-jobs.ts`, `review-jobs.ts`, `activities.ts`; Ping is an optional diagnostic exception |
| OpenAI Responses + Structured Outputs | `apps/worker/src/openai-structured-response.ts`, `openai-planner.ts`, `block-reviewer.ts`; `responses.create`, `zodTextFormat`, `store: false` |
| Three proposal attempts, not three corrections | `MAX_PROPOSAL_ATTEMPTS = 3` in `packages/shared/src/plan-generation.ts` |
| Separate infrastructure retries | `PLAN_ATTEMPTS = 3`, `SYNC_ATTEMPTS = 5` in `packages/shared/src/queue.ts`; SDK `maxRetries: 0` |
| Atomic plan/review acceptance | Transactions in `packages/db/src/plan-jobs.ts` and `review-jobs.ts` save results and success together |
| Stale-result rejection | Frozen context, current-input checks and lease fencing in DB job services; round-off handling in `planning-snapshots.ts` |
| Idempotent Strava activity rows | Unique `stravaActivityId` in Prisma schema; ownership-checked `activity.upsert` in `packages/db/src/activities.ts` |
| Adaptive lifecycle + independent focus actions | `BlockDecisionSchema`, `FocusActionSchema` and focus validation in shared block/review modules |
| Saved emphasis informs future strategy | Profile JSON, `buildBlockPlanningContext`, deterministic block selection and race-aware starter creation |
| Reported evidence is not verified execution | DB review context explicitly sets `activityLinkingAvailable: false`; shared evidence supports linked duration but the app does not supply links |
| Worker-side credentials | Worker environment loading and lazy configured provider/reviewer; no OpenAI web dependency |
| Current model default | `DEFAULT_PLANNER_MODEL = "gpt-5.6-luna"` in worker config and worker env example; account availability is not asserted |
| Safe Windows dev command | `apps/web/package.json`: `next dev --webpack`, Next pinned at 16.1.1; production `next build` unchanged |
| 268 tests / 17 suites | Recorded passing full-suite output from the Training Plan UI checkpoint; tests are not a coaching-quality benchmark |
| Deployment readiness | Monorepo tracing/build commands and deployment guide exist; no verified public URL or hosted-worker evidence supplied |

## Landing-page choices

The first section gives the product name, one-sentence purpose, the model/validator/persistence boundary, navigation, a wide calendar screenshot and four capabilities. The fuller screenshot gallery is collapsed. Architecture and AI design precede setup details; environment tables and paid evaluation commands stay lower down.

No live URL is invented. Local demo access is labeled, and deployment is described as a prepared target. Neither a successful synthetic evaluation nor a screenshot is presented as proof of a hosted or clinically validated product.

## Repository hygiene

Tracked-file inspection found only environment **examples**, and no tracked `.env` credentials, build directories, logs or crash dumps. Existing ignores cover dependencies, Next output, TypeScript output, editor/OS files and logs. Additional ignore rules cover memory dumps, heap snapshots/profiles and root Node diagnostic reports, which can contain runtime data.

A targeted scan of the 202 tracked/new non-ignored files found no recognizable private-key/API-token values. Credential-URL matches were the documented local-development password in two environment examples. No private environment files were read or added. This is not a full historical secret audit. Existing synthetic assets remain documented and useful; no license or generic contribution boilerplate was added.

## Changed files

| Files | Purpose of this pass |
| --- | --- |
| `README.md` | Product-first opening, compact calendar, four capabilities, architecture and validation diagrams, current setup/testing and honest deployment status |
| `docs/architecture.md` | Current implementation guide with direct source and regression-test links |
| `docs/README.md` | Current documentation entry points separated from historical checkpoints |
| `docs/portfolio-presentation.md` | Presentation audit, claim evidence, validation and GitHub handoff |
| `docs/deployment.md`, `docs/local-product-smoke.md` | Correct repository, deployment verification and current Training Plan controls |
| `docs/screenshots/README.md`, `docs/screenshots/readme-calendar.png` | Asset provenance, capture instructions and new compact synthetic calendar |
| `scripts/screenshot-demo.mjs`, refreshed `demo-calendar.png`, `demo-workout.png`, `demo-review.png` | Repeatable hero capture and refreshed demo views; existing mobile capture remains unchanged |
| `.gitignore` | Exclude runtime dumps, heap snapshots/profiles and root Node diagnostic reports |
| Historical docs listed below | Mark milestone scope, link current guides and correct ambiguous/outdated introductory claims |

Historical-document updates: `adaptive-block-reviews.md`, `ai-readiness.md`, `code-review.md`, `design.md`, `development-blocks.md`, `mvp-status.md`, `openai-planner.md`, `planning-context.md`, `planning-settings.md`, `pre-ai-checkpoint.md`, `product-vision.md`, `resume-readiness-audit.md` and `resume-ready-checkpoint.md`.

## Validation for this documentation pass

- `npm run typecheck`, `npm run lint` and `npm run build` passed. Next's generated type-reference change was restored; application source, dependencies and runtime configuration are unchanged.
- The screenshot script passed against a separately started production web server: interactive details, grouped repeats, resolved targets, read-only controls, mobile containment, no browser exceptions and no `/api/` requests. It captured five synthetic demo assets and stopped its own processes.
- A local Markdown/browser preview loaded all README images and rendered both Mermaid diagrams using Mermaid 10.9.1. Title, first-screen content and diagram readability were visually checked. This is a local preview, not a claim that changes have been published to GitHub.
- Parsed 26 Markdown files and checked 466 internal links, image paths and heading references; all passed. README npm commands match the root or specified workspace scripts. Code fences are balanced and `git diff --check` passed.
- Ignore checks cover real environment filenames, dependency/build output, logs and diagnostic artifacts. Only the three environment examples are tracked.
- No live Strava/OpenAI requests, real athlete changes or deployments were performed. The README's 268-test result is explicitly the prior application checkpoint; the full database suite was not rerun for these documentation/capture changes.

## GitHub settings to apply manually

**Suggested description:**

> AI triathlon planner with Strava sync, structured workouts, adaptive training blocks, and deterministic validation of model-generated plans.

**Suggested topics:**

`nextjs` · `typescript` · `strava` · `openai` · `postgresql` · `redis` · `bullmq` · `triathlon` · `training-planner` · `npm-workspaces`

1. In the repository's About settings, add the description/topics above. Add a website only when a public demo URL is verified.
2. After deployment, test `/demo` in a signed-out/private window. Put that URL in the README's opening links and GitHub website field.
3. Pin the repository on the owner profile. Optionally upload the synthetic calendar screenshot as a social preview; it contains no private athlete information.
4. Review a license choice if public reuse is intended. No existing license decision was found, so this pass does not choose one for the owner.

Do not claim deployed Vercel/Fly.io services, user counts, load/latency benchmarks, exactly-once processing, inferred fitness, automatic PR updates or coaching optimality without separate evidence. No repository metadata or publication settings are changed by these documentation edits.
