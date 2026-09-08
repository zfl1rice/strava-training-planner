# Local product audit — 2026-09-07

Before implementation: clean main, one local commit ahead of origin (`d54c08d refined AI`). Its push was blocked by automatic approval review; this task does not retry it.

| Path | Finding before changes |
| --- | --- |
| Generation UI | WeeklyPlanner POSTs scope to `/api/planner`; authenticated user is derived from the session. |
| Persistence/dispatch | `createOrReusePlanRun` stores JobRun before enqueueing `{jobRunId}`. Recovery scans unfinished requests. |
| Local provider | Defaults to deterministic. Root `.env` has no provider/key; worker `.env.local` does not exist. Web `.env.local` has no OpenAI key. No secret values were printed. External process environment can override files. |
| Worker environment | Loads worker `.env.local`, then root `.env`, before dynamically importing processor/DB. Existing process variables take precedence. |
| OpenAI path | Configured adapter exists and is exercised with mocked SDK tests. No real browser-triggered OpenAI call was verified during this audit. |
| Polling | GET `/api/planner` while pending/running; success increments calendar refresh key. Failure messaging exists but is lost after page reload. |
| Calendar | Reads saved Postgres plans via `/api/calendar`; supports v1 and v2. |
| Details | v2 charts and flattened steps render; repeat structure and recorded completion need clearer display. |
| Blocks | Persistent and used by weekly context, but created manually through scripts. No UI path; race-targeted deterministic creation needs explicit direction. |
| Reviews | Simulated persistence exists; OpenAI evaluator works. Application explicitly rejects live review until durable dispatch exists. No review UI. |
| Demo | No unauthenticated synthetic product demo. |

Smallest coherent changes: expose explicit default block creation using stored goals/races; add REVIEW_BLOCK to the existing JobRun model/queue with snapshot checks, leases and recovery; expose a small block/review panel; preserve existing weekly generation; improve details/status; add a static synthetic read-only demo, setup/deployment docs and smoke coverage. The JobRun enum migration is necessary to distinguish reviews from plan/sync jobs; no new service or queue architecture is introduced.

Paid live checks require the user to configure the worker key and execute the documented browser actions manually. Automated tests must use isolated storage and mocked providers.
