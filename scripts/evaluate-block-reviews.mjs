import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { generateBlockReview, blockReviewRequest, simulatedBlockReviewer, resolveFocusGuidance } from "@pkg/shared";
import { blockReviewScenarios, blockReviewScenarioAliases } from "../tests/fixtures/block-review-scenarios.mjs";

export async function evaluateBlockReviews(reviewer, scenarios = blockReviewScenarios()) {
  const results = [];
  for (const scenario of scenarios) {
    const calls = [];
    const started = Date.now();
    let outcome;
    try {
      const proposal = await generateBlockReview(scenario.context, reviewer ?? simulatedBlockReviewer(scenario.proposal), { reportCall: async call => { calls.push(call); } });
      outcome = { valid: true, proposal, request: blockReviewRequest(scenario.context, proposal) };
    } catch (error) { outcome = { valid: false, errors: error.issues ?? [{ code: error.category ?? "ERROR", message: error.message }] }; }
    const referenceFocusGuidance = resolveFocusGuidance(scenario.context.block.focuses, scenario.proposal.focusGuidance);
    const comparison = { blockDecision: !outcome.valid ? "UNAVAILABLE" : outcome.proposal.decision === scenario.proposal.decision ? "MATCH" : "DIFFERENT",
      focusActions: referenceFocusGuidance.map(reference => {
        const actual = outcome.proposal?.focusGuidance.find(entry => entry.focusId === reference.focusId);
        return { focusId: reference.focusId, sport: reference.sport, capability: reference.capability, referenceAction: reference.action,
          modelAction: actual?.action ?? null, result: !actual ? "UNAVAILABLE" : actual.action === reference.action ? "MATCH" : "DIFFERENT" };
      }),
    };
    results.push({ id: scenario.id, source: reviewer?.source ?? "SIMULATED", ...outcome, comparison,
      referenceDecision: scenario.proposal.decision, referenceFocusGuidance,
      block: { week: scenario.context.block.weekIndex + 1, plannedWeeks: scenario.context.block.plannedWeeks,
        role: scenario.context.block.weekRole, focuses: scenario.context.block.focuses.map(({ sport, capability, role, progressionStrategy }) => ({ sport, capability, role, progressionStrategy })) },
      evidence: { sports: scenario.context.evidence.sports,
        statuses: Object.fromEntries(["UNREPORTED", "PLANNED", "COMPLETED", "MODIFIED", "STOPPED"].map(status => [status, scenario.context.evidence.workouts.filter(workout => workout.completion === status).length])),
        reportedRpe: scenario.context.evidence.workouts.flatMap(workout => workout.feedback?.rpe == null ? [] : [workout.feedback.rpe]),
        reportedWorkouts: scenario.context.evidence.workouts.map(workout => ({ sport: workout.sport, title: workout.title,
          completion: workout.completion, rpe: workout.feedback?.rpe ?? null, comment: workout.feedback?.comment ?? null })),
        activityLinkingAvailable: scenario.context.evidence.activityLinkingAvailable, weekComplete: scenario.context.evidence.weekComplete },
      latencyMs: Date.now() - started, calls });
  }
  return results;
}

export function formatBlockReviewSummary(result) {
  return [`Scenario: ${result.id}`, `Block: week ${result.block.week} / ${result.block.plannedWeeks} | Role: ${result.block.role}`,
    ...result.block.focuses.map(focus => `${focus.role}: ${focus.sport} / ${focus.capability} | progression: ${focus.progressionStrategy}`),
    ...result.evidence.sports.map(sport => `${sport.sport}: planned ${sport.plannedMinutes ?? "unknown"} min; reported completed ${sport.reportedCompletedPlannedMinutes} planned min; recorded activity ${sport.recordedActivityMinutes ?? "unknown"} min; recorded longest ${sport.recordedLongestMinutes ?? "unknown"} min; reported completed ${sport.reportedCompletedSessions}/${sport.plannedSessions ?? "unknown"} sessions; linked ${sport.activityCoverage.linkedWorkouts}/${sport.activityCoverage.plannedWorkouts} (${sport.activityCoverage.linkedWorkouts === 0 ? "UNVERIFIED" : sport.activityCoverage.linkedWorkouts === sport.activityCoverage.plannedWorkouts ? "COMPLETE duration coverage" : "PARTIAL duration coverage"}); unlinked background ${sport.unlinkedActivityMinutes} min`),
    `Completion states: ${JSON.stringify(result.evidence.statuses)}`, `Reported RPE: ${result.evidence.reportedRpe.join(", ") || "unavailable"}`,
    ...result.evidence.reportedWorkouts.map(workout => `${workout.sport} ${workout.title}: ${workout.completion}; RPE ${workout.rpe ?? "unknown"}${workout.comment ? `; ${workout.comment.slice(0, 240)}${workout.comment.length > 240 ? "…" : ""}` : ""}`),
    "Reported completed minutes are prescribed durations, not measured execution. Linked summaries verify recorded duration only; interval targets and recovery remain unmeasured.",
    `${result.source === "OPENAI" ? "Model" : "Simulated"} BlockDecision: ${result.valid ? result.proposal.decision : "INVALID"}`,
    "Result focus guidance:",
    ...(result.request?.focusGuidance ?? []).map(entry => `${entry.role} ${entry.sport} / ${entry.capability} -> ${entry.action}: ${entry.rationale}`),
    `Reference BlockDecision: ${result.referenceDecision}`,
    "Reference focus guidance:",
    ...result.referenceFocusGuidance.map(entry => `${entry.role} ${entry.sport} / ${entry.capability} -> ${entry.action}`),
    `Reference comparison (for human review): block ${result.comparison.blockDecision}`,
    ...result.comparison.focusActions.map(entry => `${entry.sport} / ${entry.capability}: ${entry.result} (result ${entry.modelAction ?? "unavailable"}; reference ${entry.referenceAction})`),
    `Effective next week: ${result.request?.remainingWeekPattern?.[0] ?? (result.valid ? "select a replacement block; old guidance is historical" : "unavailable")}`,
    `Rationale: ${result.proposal?.rationale ?? result.errors.map(error => error.message).join("; ")}`,
    `Provider calls: ${result.calls.length} | Latency: ${(result.latencyMs / 1000).toFixed(1)} s`,
    ...result.calls.map(call => `Model: ${call.model} | Response: ${call.responseId ?? "unavailable"} | Tokens: ${call.totalTokens ?? "unknown"}`),
    ...(result.calls.length ? [] : ["Model: none (no provider call) | Tokens: 0"]),
    "Validation checks structure/lifecycle, not whether the coaching recommendation is optimal.",
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const live = args[0] === "--openai";
  if (live) args.shift();
  const id = args[0] === "--scenario" ? args[1] : undefined;
  if (args.length && (!id || args.length !== 2)) throw new Error("Usage: evaluate-block-reviews.mjs [--openai] [--scenario ID]");
  const canonicalId = Object.hasOwn(blockReviewScenarioAliases, id) ? blockReviewScenarioAliases[id] : id;
  const scenarios = blockReviewScenarios().filter(scenario => !canonicalId || scenario.id === canonicalId);
  if (!scenarios.length) throw new Error(`Unknown review scenario: ${id}`);
  let reviewer;
  if (live) {
    const { config } = await import("dotenv");
    config({ path: new URL("../apps/worker/.env.local", import.meta.url), quiet: true });
    const { readPlannerConfig } = await import("../apps/worker/dist/planner-config.js");
    const { createOpenAIBlockReviewer } = await import("../apps/worker/dist/block-reviewer.js");
    reviewer = createOpenAIBlockReviewer(readPlannerConfig({ ...process.env, PLANNER_PROVIDER: "openai" }));
    console.error(`Live review evaluation: ${scenarios.length} scenario(s), up to three paid calls each. No application records are written.`);
  }
  const results = await evaluateBlockReviews(reviewer, scenarios);
  for (const result of results) console.error(`\n${formatBlockReviewSummary(result)}\n`);
  console.log(JSON.stringify(results, null, 2));
  if (results.some(result => !result.valid)) process.exitCode = 1;
}
