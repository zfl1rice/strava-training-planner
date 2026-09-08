# Windows dev-mode PostCSS process growth

## Fix

`apps/web/package.json` now uses `next dev --webpack`. Run **`npm run dev` from the monorepo root**, then open http://localhost:3000. `npm run dev:web` and `npm run dev --workspace @app/web` inherit the same fix.

Next.js remains **16.1.1**. Tailwind, PostCSS configuration, global CSS, the worker, and production build scripts are unchanged. Turbopack is disabled for development; `next build` still uses its existing default bundler. The only functional edit for this issue is the web dev script. README links to this investigation.

## Diagnosis and limits

The failure was reproduced on Windows with Node **24.12.0**, Next **16.1.1**, and Tailwind / `@tailwindcss/postcss` **4.1.18**. Opening the page triggers on-demand CSS compilation. Turbopack then accumulates Node children executing `apps/web/.next/dev/build/postcss.js <port>`, all parented by its dev server. The application worker is not their parent.

The existing dev cache reproduces the problem; a fresh dev cache did not reproduce it in short tests. Restoring the preserved cache reproduced it again. This localizes the failure to **state-dependent Turbopack dev/PostCSS execution**, with cached state implicated. It does **not** establish the exact Rust task/cache defect or the event that originally created that state. No framework source patch or bisect was performed, so this report does not claim an identified upstream fix, a confirmed version regression, or Windows exclusivity.

Clearing the cache alone is not a dependable repository fix: it leaves the demonstrated failing execution path enabled. Webpack successfully compiles the same source, plugin configuration, and dependency tree, including when the problematic Turbopack cache is present. Choosing the supported dev bundler is the smallest containment for the tooling failure (option B), without changing the app architecture or upgrading Next speculatively.

## Experiments

Counts below cover Node descendants of the launched npm command, including npm/Next wrappers. They exclude the test browser, monitoring process, and unrelated Node programs. Memory is summed working set, not system commit or a heap measurement. A watchdog samples roughly every two seconds and stops only its own process tree above 12 PostCSS children or 3,500 MiB. Rapid spawning can overshoot between samples.

| Experiment | Observed behavior |
| --- | --- |
| Original `npm run dev --workspace @app/web` | At 13/16/18/20 seconds: **1/4/9/29 PostCSS children**. Last sample: 32 total Node processes, 4,171 MiB. Watchdog stopped the tree. `/` returned HTTP 200 before the growth. |
| Same web command with `-- --webpack` | **3 Node processes, 0 PostCSS children** throughout the 70-second comparison after startup; settled near 867 MiB. Browser interaction/style smoke passed. |
| Fresh dev cache, DEBUG cleared | **4 Node processes, 1 PostCSS child** through 45 seconds. Both `/` and `/demo` rendered. |
| Restart against fresh cache, original environment | **4 Node processes, 1 PostCSS child** through 45 seconds. This argues against the inherited DEBUG flag causing the failure. |
| Restore old dev cache, DEBUG cleared | **14 PostCSS children / 17 Node processes at 9 seconds**, then watchdog stop. |
| Old cache, temporary Tailwind `source("../")` restricted to `src` | **13 PostCSS children / 16 Node processes at 9 seconds**, then watchdog stop. CSS restored afterward. Narrowing the scan did not fix the issue. |

The fixed root `npm run dev` held **8 Node processes after startup and 0 PostCSS children** across a six-minute web + worker run (last sample at 359 seconds). Peak working set was 1,579 MiB; final was 1,523 MiB. The browser completed five minutes of repeated reloads after its initial functional checks.

Local raw samples and temporary diagnostic harnesses are in ignored `logs/` files (`turbo-*`, `webpack-*`, `combined-*`). These are investigation artifacts, not application dependencies or committed fixtures.

## Functional verification

- Headless Edge visited the homepage and synthetic calendar. Homepage and stylesheet returned HTTP 200. Calendar/detail interaction, repeat groups, power targets, and mobile containment passed; screenshots were visually inspected.
- Computed styles verified existing Tailwind typography/spacing and custom calendar borders. Changing component text and introducing a new `text-[31px]` utility updated the browser without a page reload. A separate global CSS edit also hot-reloaded; all temporary source edits were restored.
- With web and worker launched by the fixed root command, HTTP enqueue -> Redis/BullMQ -> validated PingJob completed. Invalid requests and unknown jobs were rejected as expected. This used a disposable database, an isolated queue prefix, and deterministic provider configuration; no athlete records or paid provider calls were involved.
- The browser then reloaded every 30 seconds for five minutes, with no runtime exceptions or PostCSS child growth. Process monitoring continued to six minutes, followed by cleanup of the test process tree and database.
- `npm test`: **252 tests across 15 suites, zero failures**. `npm run typecheck` and `npm run lint`: passed.
- `npm run build`: passed with exit code 0, still using Turbopack for the production build. The monitored build peaked at one PostCSS child and 1,931 MiB across the build tree; static-page workers exited after completion. The monitor itself initially failed to retain the finished process's exit code, so the normal build was rerun directly to confirm success.
- `npm run start --workspace @app/web`: **2 Node processes, 0 PostCSS children** over 60 seconds; settled near 197 MiB. The same browser interaction/style smoke passed against this production server.

## Hypotheses checked

| Hypothesis | Evidence / conclusion |
| --- | --- |
| Malformed or recursive PostCSS configuration | One plain ESM configuration containing `@tailwindcss/postcss: {}`; no custom plugin, recursive loader, or generated config. A direct PostCSS transform completed in 76 ms. |
| Wrong Tailwind v4 integration | The project uses the v4 PostCSS plugin and `@import "tailwindcss"`, matching the [official setup](https://tailwindcss.com/docs/installation/using-postcss). There is no legacy Tailwind config. |
| Duplicated/conflicting workspace dependencies | `npm ls` shows one deduplicated Tailwind 4.1.18. Next owns PostCSS 8.4.31; Tailwind's plugin owns PostCSS 8.5.6. Both bundlers use this same installed tree; changing resolutions was not needed. |
| Generated `.next` output scanned as content | Direct plugin inspection returned 48 file dependencies and one directory glob rooted at `apps/web/src`; no `.next`, `dist`, or log dependency. `.next/` is gitignored. Tailwind [excludes gitignored files by default](https://tailwindcss.com/docs/detecting-classes-in-source-files). |
| Generated config / root-file watch loop | No config generator or recursive dev script exists. Default Tailwind scanning includes `next-env.d.ts`, but restricting scanning to `src` still reproduces the runaway. |
| CSS import cycle / plugin recursion | Global CSS imports Tailwind once; no custom recursive imports. Direct compilation and Webpack both succeed. |
| Build-error retry loop | The first failing reproduction returned `/` with HTTP 200 and had no PostCSS compilation errors before spawning accelerated. |
| Turbopack process/cache failure on Windows | Reproduced three bounded failures with the existing cache. Fresh-cache comparisons were bounded. Webpack avoids the failing child-process path. Evidence supports a tooling issue, but does not establish a Windows-only cause. |

## Framework context

Next 16 defaults to Turbopack and officially supports opting out with [`next dev --webpack`](https://nextjs.org/docs/app/guides/upgrading/version-16). An [upstream report of proliferating PostCSS processes](https://github.com/vercel/next.js/issues/95108) describes similar symptoms on another platform/version. It was closed for an invalid reproduction link, **not** as a confirmed fixed bug; it is context rather than proof of this repository's internal cause. There is no justified version upgrade in this change.

## Inspecting processes yourself

From the repository root, in a second PowerShell window:

```powershell
$repoPattern = [regex]::Escape((Get-Location).Path)
$nodes = @(Get-CimInstance Win32_Process -Filter "name='node.exe'")
$postcss = @($nodes | Where-Object {
  $_.CommandLine -match $repoPattern -and $_.CommandLine -match '[/\\]postcss\.js'
})
$postcss | Select-Object ProcessId, ParentProcessId, CommandLine
"PostCSS child processes: $($postcss.Count)"
```

With the fixed Webpack dev command, that PostCSS-child count should be zero. There will still be normal Node processes for npm, concurrently, Next, and the separate worker. The monitored tests terminate only descendants of their own launch PID, never every Node process on the machine.
