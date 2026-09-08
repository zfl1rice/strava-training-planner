# Screenshot inventory

All tracked screenshots show synthetic data, never a private athlete's activity export. The wide README image is a direct browser capture of the populated calendar table, cropped at capture time to keep the landing page compact. Its synthetic provenance is stated alongside the image in the README.

| Asset | Shows | Capture source |
| --- | --- | --- |
| [readme-calendar.png](readme-calendar.png) | Populated calendar weeks, green recorded activities and blue workouts | Public read-only `/demo`, table capture |
| [demo-calendar.png](demo-calendar.png) | Full demo calendar view | `/demo` |
| [demo-workout.png](demo-workout.png) | Repeated intervals, instructions and resolved watts | `/demo` workout dialog |
| [demo-review.png](demo-review.png) | Illustrative global review and focus guidance | `/demo` block summary |
| [demo-mobile.png](demo-mobile.png) | Narrow-screen calendar containment | `/demo` |
| [training-plan-collapsed.png](training-plan-collapsed.png) | Training focus and collapsed strategy sections | Disposable synthetic authenticated account |
| [training-plan-emphasis.png](training-plan-emphasis.png) | Focus percentages, saved rationale and week structure | Disposable synthetic authenticated account |
| [training-plan-clear.png](training-plan-clear.png) | Protected clear-week confirmation | Disposable synthetic authenticated account |
| [training-plan-mobile.png](training-plan-mobile.png) | Training Plan card on mobile | Disposable synthetic authenticated account |

No placeholders are needed. The demo's hand-authored workouts/review illustrate the product; screenshots do not establish live AI quality or production deployment.

## Recapture

From the repository root, run `npm run dev` (or build/start the web app), then in another terminal:

```powershell
node scripts/screenshot-demo.mjs http://localhost:3000
```

This captures five demo images including the README hero and checks that the demo sends no authenticated application API requests. It uses installed Microsoft Edge on Windows, or `CHROME_PATH` pointing to Chromium, with a temporary browser profile and localhost-only destination.

For the four authenticated-control screenshots:

```powershell
npm run build:packages
npm run build --workspace @app/web
node scripts/smoke-training-ui.mjs
```

That script creates a disposable Postgres database, an isolated local server and synthetic session. It tests save/reload, review cancellation, clear protection and mobile layout; stops its own processes and drops its test database. It does not contact Strava or OpenAI.

Do not replace these assets with real activity screenshots unless names, routes, identifiers, comments and other private details have been removed. Local screenshots of generated plans and logs can contain private data even when credentials are not visible.
