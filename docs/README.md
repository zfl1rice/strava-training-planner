# Documentation

Start with the [project README](../README.md) for the product, diagrams, local setup and test commands. This index separates current implementation guides from historical checkpoints, whose test counts and deferred items describe an earlier version.

## Current entry points

| Read this | To understand |
| --- | --- |
| [Architecture](architecture.md) | Process boundaries, ingestion, proposal validation, atomic persistence and adaptive reviews |
| [Training Plan UI](training-plan-ui.md) | Sport emphasis, rationale, clearing rules, file review map and 268-test application checkpoint |
| [OpenAI planning design](openai-planner.md) | Transport, prompt design, structured output, correction and evaluation details; dated follow-ups are marked |
| [BlockReview identity](block-review-focus-identity.md) | Stable focus IDs, coverage validation and server-owned metadata |
| [Review evidence and guidance](block-review-focus-guidance.md) | Reported versus recorded evidence and separate global/per-focus decisions |
| [Local product smoke](local-product-smoke.md) | Run and verify the UI; distinguish mocked checks from paid/live verification |
| [Deployment preparation](deployment.md) | Vercel web, managed storage, independent worker and public demo verification |
| [Windows dev fix](dev-process-spawn.md) | Why development uses Webpack on Next.js 16.1.1 |
| [Screenshot inventory](screenshots/README.md) | Synthetic assets, provenance and recapture commands |
| [Portfolio presentation](portfolio-presentation.md) | Claim audit, GitHub description/topics and publication checklist |

## Design history and specialist references

- [Original detailed design](design.md) and [source-review history](code-review.md): earlier implementation snapshots, including fixed-template and pre-AI behavior. Use the current architecture and UI guide first.
- [Product vision](product-vision.md): long-term direction; includes features still intentionally deferred.
- [Planning context](planning-context.md), [settings foundation](planning-settings.md), [pre-AI checkpoint](pre-ai-checkpoint.md), [AI readiness](ai-readiness.md): progressive milestones, not current feature inventories.
- [Development-block foundation](development-blocks.md), [adaptive review foundation](adaptive-block-reviews.md), [review boundary scenarios](block-review-boundaries.md), [percentage-target correction](planner-target-units.md): rationale and specialist regression coverage.
- [Integration audit](resume-readiness-audit.md), [integration checkpoint](resume-ready-checkpoint.md), [status timeline](mvp-status.md): historical verification records. Older counts are intentionally retained with their checkpoint context.

The [example planning context](planning-context.example.json) and [proposal](plan-proposal.example.json) are examples, not live athlete exports or evidence of a deployed service.
