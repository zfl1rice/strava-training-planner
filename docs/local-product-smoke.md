# Local product smoke test

Use the monorepo directory containing `package.json`. This checklist distinguishes offline tests from real Strava/OpenAI verification. No script silently starts paid evaluations.

## Start

```powershell
npm install
docker compose up -d postgres redis
npm run db:generate
npm run db:deploy
npm run check:local
npm run dev
```

First configure `.env` and `apps/web/.env.local` using their examples, preserving existing credentials. For OpenAI, set `PLANNER_PROVIDER=openai` and `OPENAI_API_KEY` in `apps/worker/.env.local`; choose a model accessible to your API account. Never put the key in web. Restart the worker after editing this file.

## Manual end-to-end checks

1. Open `http://localhost:3000/demo` in a private window. Synthetic activities are green and planned workouts blue. Click the bike intervals; check the three repeats, durations, percent FTP, watts, and explanation. No Strava login or model call is needed.
2. Open `http://localhost:3000`. Click Connect Strava and approve activity access. Expect connected status. Confirm worker terminal reports `Worker ready on queue jobs`.
3. Click Sync Activities. Watch pending/running/success, activity count, last sync time, and calendar refresh. Sync again: a fixed set of Strava IDs should retain the same record count (new/updated upstream activities can change content).
4. Save Profile baselines/timezone, Goals, Availability, and any Restrictions/Adjustments. For General Fitness, leave upcoming races empty. Alternatively add an event with date, priority, and demands/duration.
5. Click Create training block, or let the first generation create one. Check phase, primary/supporting sport focus, dates, and week pattern. Starter defaults are visible and are not inferred fitness assessments.
6. **Paid action:** in Plan settings & weekly goals, click Generate next week's plan once. Browser Network should show POST `/api/planner` with 202 and GET polling. Worker should log `planner.provider_call` with the selected model, response ID, latency/tokens, and proposal attempt. No API key should appear in browser traffic.
7. Confirm SUCCESS and new calendar entries without refreshing the page. Navigate to next month if the generated week crosses the month boundary. Expand the plan details to see provider/model provenance and desired-versus-planned minutes.
8. Click a workout. Check warm-up, repeats, work/recovery steps, targets, duration and explanation. Save completion (completed/modified/stopped), RPE and comments. Reopen it to verify persistence.
9. A review applies to the current or immediately preceding saved week, within the active block. To exercise the flow on a new account today, use **Regenerate the rest of this week** (another paid generation) and save feedback on a current-week workout. That review is explicitly marked in progress, not presented as a completed-week assessment. To verify a fully completed week, return the following week; do not falsify activity history.
10. **Paid action:** select the saved week in Training block & review, then click Review Week once. Observe persistent pending/running status. Worker logs `block_review.provider_call`; the panel updates to the global decision, per-focus guidance, rationale, and effective date.
11. Generate the next week to apply latest guidance (another paid action). Inspect the saved plan's `developmentBlock.previousReview` in the planner response to verify the review enters the weekly context. Existing completed/locked workouts remain protected during remaining-week regeneration. A terminal review closes the old block; subsequent generation creates a new starter block, or use Create training block explicitly.
12. Check failure behavior without a paid call: stop the worker, submit a request, and verify PENDING survives reload. Restart the worker to recover it. To test missing-key handling, use a separate test configuration: generation/review must fail usefully and retain the previous plan/block. Do not edit goals while intentionally testing a successful live response; separate stale-result tests cover that behavior.

For automated coverage instead of paid calls:

```powershell
npm run test:review-jobs
```

This uses real Postgres, Redis, authenticated route handlers and worker processing, but intercepts OpenAI requests with fixture responses. It checks generation-to-calendar, feedback-to-review, stale results, ownership, retries, and recovery. It does not prove the live account credentials/model are valid.

## Screenshots

- `/demo`: calendar showing green activities and blue structured workouts.
- Click “Bike threshold intervals 3 × 8 min”: grouped repeats and 250 W baseline targets.
- Scroll to “Illustrative block review”: global decision and per-focus guidance.
- Optional: capture your own real successful generation with provider provenance, after removing personal names and private activity details.

Use a desktop browser at roughly 1440px width, and also check narrow-screen horizontal calendar scrolling. Keep “SYNTHETIC DATA” visible on demo screenshots. Four synthetic images are saved in `docs/screenshots/`. To regenerate them, start web and run `node scripts/screenshot-demo.mjs http://localhost:3000`. This optional script uses installed Microsoft Edge on Windows (or `CHROME_PATH` pointing to Chromium), an isolated temporary browser profile, and a localhost-only URL. It asserts that no authenticated application API is called. No real athlete screenshots are collected.

## Verified and unverified

See `resume-ready-checkpoint.md` for actual automated results. Manual live OAuth and paid OpenAI checks require your credentials and are not claimed complete from evaluator output or mocked tests.
