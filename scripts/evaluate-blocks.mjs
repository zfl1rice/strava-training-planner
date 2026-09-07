import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  DevelopmentBlockSchema, PlanningContextSchema, activeBlockForWeek, deterministicBlockPlanner,
  generatePlanWithCorrections, validateBlockProposal,
} from "@pkg/shared";
import { blockScenarios } from "../tests/fixtures/block-scenarios.mjs";

// Local schema/context evaluation. Phases and review decisions are fixture inputs;
// this does not evaluate a live coach's selection quality or physiological effects.
export async function evaluateBlocks(provider = deterministicBlockPlanner) {
  const results = [];
  for (const scenario of blockScenarios()) {
    try {
      const proposal = validateBlockProposal(scenario.context, await provider.createBlock(structuredClone(scenario.context)));
      const reviews = scenario.decision ? [{ id: 1, revision: 2, createdAt: scenario.weekly.generatedAt,
        request: { reviewedWeekStart: "2026-08-31", effectiveWeekStart: "2026-09-07", decision: scenario.decision,
          rationale: scenario.reviewRationale ?? "Explicit synthetic response supports this review decision.",
          ...(scenario.remainingWeekPattern ? { remainingWeekPattern: scenario.remainingWeekPattern } : {}) },
        response: { capturedAt: scenario.weekly.generatedAt,
          restrictions: scenario.weekly.restrictions,
          availability: scenario.weekly.availability.days.map(day => ({ date: day.date, settings: day.settings, note: day.note })),
          sports: ["RUN", "BIKE", "SWIM"].map(sport => ({ sport, plannedMinutes: null, plannedSessions: null, activityMinutes: null,
            activitySessions: null, longestMinutes: null, reportedCompletedSessions: null })),
          feedback: [], feedbackTruncated: false, performanceEvidenceIds: [], notes: ["Synthetic supplied decision, not automatically inferred."],
        },
      }] : [];
      const block = DevelopmentBlockSchema.parse({ id: 1, userId: 1, revision: reviews.length + 1, status: "ACTIVE", proposal,
        reviews, createdAt: scenario.weekly.generatedAt, updatedAt: scenario.weekly.generatedAt });
      const developmentBlock = activeBlockForWeek(block, scenario.weekly.targetWeek.startDate);
      const context = PlanningContextSchema.parse({ ...scenario.weekly, developmentBlock, seasonPhase: developmentBlock.phase });
      const plan = await generatePlanWithCorrections({ version: 1, context, fromDate: context.targetWeek.startDate, protectedWorkouts: [] });
      assert.deepEqual(context.goals, scenario.weekly.goals);
      assert.deepEqual(plan.developmentBlock, developmentBlock);
      assert.deepEqual(context.performanceProfile, scenario.weekly.performanceProfile);
      if (scenario.decision) assert.equal(developmentBlock.previousReview.request.decision, scenario.decision);
      if (scenario.remainingWeekPattern) assert.equal(developmentBlock.weekRole, scenario.remainingWeekPattern[0]);
      if (scenario.id === "completion-next-focus") assert.notEqual(proposal.focuses.find(focus => focus.role === "PRIMARY").sport,
        scenario.recentBlocks[0].proposal.focuses.find(focus => focus.role === "PRIMARY").sport);
      results.push({ id: scenario.id, valid: true, description: scenario.description, objective: context.planningObjective.mode,
        strategy: developmentBlock, goals: context.goals, suppliedRecentBlockStatuses: scenario.recentBlocks.map(block => block.status) });
    } catch (error) { results.push({ id: scenario.id, valid: false, error: error.message }); }
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const results = await evaluateBlocks();
  console.log(JSON.stringify(results, null, 2));
  console.error(`Block fixtures: ${results.filter(result => result.valid).length}/${results.length} passed. Local only; no paid calls.`);
  if (results.some(result => !result.valid)) process.exitCode = 1;
}
