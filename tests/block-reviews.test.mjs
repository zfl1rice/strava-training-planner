import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import OpenAI from "openai";
import { spawnSync } from "node:child_process";
import {
  BlockReviewContextSchema, BlockReviewProposalSchema, blockReviewRequest, generateBlockReview,
  simulatedBlockReviewer, defaultDayAvailability, emptyAthleteProfile, finalizePlanProposal,
  GenerationInputSchema, activeBlockForWeek, summarizeBlockReviewSports, BlockReviewEvidenceSchema,
  validateBlockReviewProposal, BlockReviewSchema, developmentFocusId, resolveFocusGuidance,
} from "@pkg/shared";
import {
  prisma, saveWeeklyGoals, createDevelopmentBlock, generateAndSaveFlexiblePlan, saveWorkoutStates,
  buildBlockReviewContext, reviewAndSaveBlockWeek, getDevelopmentBlock, buildPlanningContext,
  StaleBlockGenerationError, saveAthleteProfile, getActiveDevelopmentBlock, StaleGenerationError, recordBlockReview,
} from "@pkg/db";
import { createOpenAIBlockReviewer, BLOCK_REVIEW_INSTRUCTIONS } from "../apps/worker/src/block-reviewer.ts";
import { PLANNER_INSTRUCTIONS, buildOpenAIPlanningInput } from "../apps/worker/src/planner-prompt.ts";
import { blockReviewScenarios, blockReviewBoundaryScenarioIds, blockReviewScenarioAliases } from "./fixtures/block-review-scenarios.mjs";
import { planningScenarios } from "./fixtures/planning-scenarios.mjs";
import { evaluateBlockReviews, formatBlockReviewSummary } from "../scripts/evaluate-block-reviews.mjs";

assert.match(process.env.OAUTH_TEST_DATABASE ?? "", /^planner_oauth_test_[a-f0-9]{16}$/);
assert.equal(new URL(process.env.DATABASE_URL).pathname, `/${process.env.OAUTH_TEST_DATABASE}`);
const createAt = new Date("2026-09-06T12:00:00Z");
const reviewAt = new Date("2026-09-14T12:00:00Z");
const recommendation = (decision, focuses = [{ sport: "RUN", capability: "LONG_ENDURANCE", role: "PRIMARY" }]) => ({
  decision, rationale: `Supplied ${decision} recommendation after reviewing the recorded response.`,
  focusGuidance: focuses.map(focus => ({ focusId: developmentFocusId(focus),
    action: focus.role === "MAINTENANCE" ? "MAINTAIN" : decision === "PROGRESS" && focus.role === "PRIMARY" ? "PROGRESS" : "HOLD",
    rationale: "Explicit guidance based on supplied evidence and the focus priority." })),
});
let user;
beforeEach(async () => {
  await prisma.activity.deleteMany(); await prisma.jobRun.deleteMany(); await prisma.user.deleteMany();
  user = await prisma.user.create({ data: {} });
  await saveWeeklyGoals(user.id, { RUN: 120, BIKE: 240, SWIM: 60 });
});
after(async () => { await prisma.$disconnect(); });
async function seed(pattern = ["DEVELOPMENT", "DEVELOPMENT", "DEVELOPMENT", "RECOVERY"],
  focuses = [{ sport: "RUN", capability: "LONG_ENDURANCE", role: "PRIMARY", progressionStrategy: "LONG_SESSION", rationale: "Supplied primary emphasis." }]) {
  const block = await createDevelopmentBlock(user.id, { startDate: "2026-09-07", phase: "GENERAL_PREPARATION",
    weekPattern: pattern, raceIds: [], rationale: "Run durability development with sufficient supporting work.",
    focuses }, { now: createAt });
  const plan = await generateAndSaveFlexiblePlan(user.id, createAt);
  const workouts = plan.content.days.filter(day => day.kind === "WORKOUT");
  await saveWorkoutStates(user.id, plan.id, plan.updatedAt, workouts.map(workout => ({ workoutId: workout.id, date: workout.date,
    templateId: workout.templateId ?? "custom", locked: true, completion: "COMPLETED", feedback: { rpe: 3, comment: "Completed comfortably." } })));
  await prisma.activity.createMany({ data: workouts.map(workout => ({ userId: user.id, type: workout.sport,
    startedAt: new Date(`${workout.date}T12:00:00Z`), durationSeconds: Math.round(workout.durationMinutes * 60), source: "MANUAL" })) });
  return { block, plan: await prisma.weeklyPlan.findUniqueOrThrow({ where: { id: plan.id } }) };
}
const saveReview = (block, decision, at = reviewAt) => reviewAndSaveBlockWeek(user.id, block.id, block.revision,
  "2026-09-07", simulatedBlockReviewer(recommendation(decision, block.proposal.focuses)), at);

test("review contracts accept decisions, focus guidance and rationale and validate context dates", () => {
  for (const decision of ["PROGRESS", "HOLD", "RECOVER_EARLY", "CONTINUE_RECOVERY", "COMPLETE_BLOCK", "REPLAN_BLOCK"]) assert.ok(BlockReviewProposalSchema.safeParse(recommendation(decision)).success);
  assert.equal(BlockReviewProposalSchema.safeParse({ ...recommendation("PROGRESS"), actualMinutes: 500 }).success, false);
  assert.equal(BlockReviewProposalSchema.safeParse(recommendation("INVENTED")).success, false);
  const context = structuredClone(blockReviewScenarios()[0].context);
  context.effectiveWeekStart = "2026-09-21";
  assert.equal(BlockReviewContextSchema.safeParse(context).success, false);
});

test("review context calculates owned facts and distinguishes recorded activity from completion", async () => {
  const { block, plan } = await seed();
  const other = await prisma.user.create({ data: {} });
  await prisma.activity.create({ data: { userId: other.id, type: "RUN", startedAt: new Date("2026-09-09"), durationSeconds: 36000 } });
  const context = await buildBlockReviewContext(user.id, block.id, "2026-09-07", reviewAt);
  const run = context.evidence.sports.find(value => value.sport === "RUN");
  assert.equal(run.plannedMinutes, 120); assert.equal(run.reportedCompletedPlannedMinutes, 120);
  assert.equal(run.recordedActivityMinutes, null); assert.equal(run.recordedActivitySessions, null);
  assert.equal(run.recordedLongestMinutes, null); assert.equal(run.activityCoverage.linkedWorkouts, 0);
  assert.equal(run.unlinkedActivityMinutes, 120);
  assert.equal(context.evidence.plan.id, plan.id);
  assert.equal(context.evidence.activityLinkingAvailable, false);
  assert.ok(context.evidence.workouts.every(workout => workout.achievedTargets === null));
  assert.ok(!JSON.stringify(context).includes("accessToken"));
  await assert.rejects(buildBlockReviewContext(other.id, block.id, "2026-09-07", reviewAt), /owned block/);
});

test("local timezone and an in-progress boundary preserve partial evidence and unknown completion", async () => {
  const { block, plan } = await seed();
  await prisma.weeklyPlan.update({ where: { id: plan.id }, data: { workoutStates: [] } });
  await saveAthleteProfile(user.id, emptyAthleteProfile(), "America/Chicago");
  await prisma.activity.create({ data: { userId: user.id, type: "RUN", startedAt: new Date("2026-09-07T01:00:00Z"), durationSeconds: 600 } });
  const context = await buildBlockReviewContext(user.id, block.id, "2026-09-07", new Date("2026-09-10T20:00:00Z"));
  assert.equal(context.evidence.weekComplete, false);
  assert.ok(context.evidence.workouts.every(workout => workout.completion === "UNREPORTED"));
  assert.ok(context.evidence.activities.every(activity => activity.date >= "2026-09-07" && activity.date <= "2026-09-10"));
  assert.match(context.evidence.notes.join(" "), /in progress/);
});

test("PROGRESS persists evidence and reaches the next weekly planner without changing goals or protected history", async () => {
  const { block, plan } = await seed();
  const reviewed = await saveReview(block, "PROGRESS");
  assert.deepEqual(reviewed.proposal.focuses, block.proposal.focuses);
  assert.equal(reviewed.reviews[0].source.provider, "SIMULATED");
  assert.equal(reviewed.reviews[0].evidence.sports.find(value => value.sport === "RUN").reportedCompletedPlannedMinutes, 120);
  assert.equal(reviewed.reviews[0].response.sports.find(value => value.sport === "RUN").recordedActivityMinutes, null);
  assert.deepEqual(await prisma.weeklyPlan.findUniqueOrThrow({ where: { id: plan.id } }), plan);
  const context = await buildPlanningContext(user.id, { now: reviewAt, weekStart: "2026-09-14" });
  assert.equal(context.developmentBlock.previousReview.request.decision, "PROGRESS");
  assert.equal(context.developmentBlock.previousReview.evidence, undefined);
  assert.equal(context.goals.RUN, 120);
  assert.equal(buildOpenAIPlanningInput({ version: 1, context, fromDate: "2026-09-14", protectedWorkouts: [] }).developmentBlock.previousReview.request.decision, "PROGRESS");
  assert.ok((await generateAndSaveFlexiblePlan(user.id, reviewAt, "REMAINING_WEEK")).content.days.length);
});

test("HOLD keeps the block active, and regenerated reviews append without rewriting history", async () => {
  const { block } = await seed();
  const first = await saveReview(block, "HOLD");
  const second = await saveReview(first, "PROGRESS");
  assert.equal(first.status, "ACTIVE");
  assert.deepEqual(second.reviews[0], first.reviews[0]);
  assert.equal(second.reviews.length, 2);
  assert.equal(activeBlockForWeek(second, "2026-09-14").weekRole, "DEVELOPMENT");
});

test("RECOVER_EARLY changes only future roles and CONTINUE_RECOVERY can extend recovery", async () => {
  const { block } = await seed();
  const early = await saveReview(block, "RECOVER_EARLY");
  assert.equal(activeBlockForWeek(early, "2026-09-07").weekRole, "DEVELOPMENT");
  assert.equal(activeBlockForWeek(early, "2026-09-14").weekRole, "RECOVERY");
  const extended = await reviewAndSaveBlockWeek(user.id, block.id, early.revision, "2026-09-14",
    simulatedBlockReviewer(recommendation("CONTINUE_RECOVERY")), new Date("2026-09-21T12:00:00Z"));
  assert.equal(activeBlockForWeek(extended, "2026-09-21").weekRole, "RECOVERY");
  assert.deepEqual(extended.proposal.weekPattern, block.proposal.weekPattern);
});

test("successful recovery can resume development without numerical progression in the reviewer", async () => {
  const { block } = await seed(["RECOVERY", "DEVELOPMENT", "RECOVERY"]);
  const result = await saveReview(block, "PROGRESS");
  assert.equal(activeBlockForWeek(result, "2026-09-14").weekRole, "DEVELOPMENT");
  assert.equal((await buildPlanningContext(user.id, { now: reviewAt })).goals.RUN, 120);
});

for (const [decision, status] of [["COMPLETE_BLOCK", "COMPLETED"], ["REPLAN_BLOCK", "ABORTED"]]) {
  test(`${decision} closes the strategy and prevents generic fallback before replacement`, async () => {
    const { block, plan } = await seed();
    const result = await saveReview(block, decision);
    assert.equal(result.status, status);
    assert.equal(await getActiveDevelopmentBlock(user.id), null);
    const context = await buildPlanningContext(user.id, { now: reviewAt });
    assert.equal(context.blockTransition.status, status);
    await assert.rejects(generateAndSaveFlexiblePlan(user.id, reviewAt), StaleGenerationError);
    assert.equal(GenerationInputSchema.safeParse({ version: 1, context, fromDate: context.targetWeek.startDate, protectedWorkouts: [] }).success, false);
    assert.deepEqual(await prisma.weeklyPlan.findUniqueOrThrow({ where: { id: plan.id } }), plan);
    await assert.rejects(saveReview(result, "HOLD"), /owned block/);
    const { version: _version, ...direction } = block.proposal;
    await createDevelopmentBlock(user.id, { ...direction, startDate: "2026-09-14" }, { now: reviewAt });
    assert.equal((await buildPlanningContext(user.id, { now: reviewAt })).blockTransition, null);
  });
}

test("in-flight review cannot overwrite a newer review", async () => {
  const { block } = await seed(); const entered = Promise.withResolvers(); const release = Promise.withResolvers();
  const pending = reviewAndSaveBlockWeek(user.id, block.id, 1, "2026-09-07", { source: "SIMULATED", async review() { entered.resolve(); await release.promise; return recommendation("PROGRESS"); } }, reviewAt);
  await entered.promise; const newer = await saveReview(block, "HOLD"); release.resolve();
  await assert.rejects(pending, StaleBlockGenerationError);
  assert.deepEqual((await getDevelopmentBlock(user.id, block.id)).reviews, newer.reviews);
});

test("changed feedback, dated availability, and recorded activity invalidate frozen review evidence", async () => {
  const { block, plan } = await seed();
  for (const change of [async () => { await prisma.weeklyPlan.update({ where: { id: plan.id }, data: { workoutStates: [] } }); },
    async () => { const profile = emptyAthleteProfile(); profile.availability.overrides = [{ date: "2026-09-15", settings: { ...defaultDayAvailability(), availableMinutes: 0, maxSessions: 0 }, note: "Travel" }]; await saveAthleteProfile(user.id, profile, "UTC"); },
    async () => { await prisma.activity.create({ data: { userId: user.id, type: "RUN", startedAt: new Date("2026-09-10T12:00:00Z"), durationSeconds: 1200 } }); }]) {
    const entered = Promise.withResolvers(); const release = Promise.withResolvers();
    const pending = reviewAndSaveBlockWeek(user.id, block.id, 1, "2026-09-07", { source: "SIMULATED", async review() { entered.resolve(); await release.promise; return recommendation("PROGRESS"); } }, reviewAt);
    await entered.promise; await change(); release.resolve();
    await assert.rejects(pending, StaleBlockGenerationError);
  }
  assert.equal((await getDevelopmentBlock(user.id, block.id)).reviews.length, 0);
});

test("future and obsolete review boundaries are rejected, while uncovered weekly generation waits for review", async () => {
  const { block } = await seed(["DEVELOPMENT"]);
  await assert.rejects(buildBlockReviewContext(user.id, block.id, "2026-09-07", createAt), /boundary/);
  await assert.rejects(buildBlockReviewContext(user.id, block.id, "2026-09-07", new Date("2026-09-21T12:00:00Z")), /boundary/);
  await assert.rejects(generateAndSaveFlexiblePlan(user.id, reviewAt, "REMAINING_WEEK"), StaleGenerationError);
  await saveReview(block, "HOLD");
  assert.equal((await buildPlanningContext(user.id, { now: reviewAt, weekStart: "2026-09-14" })).developmentBlock.weekRole, "DEVELOPMENT");
  assert.ok((await generateAndSaveFlexiblePlan(user.id, reviewAt, "REMAINING_WEEK")).content.days.length);
});

test("live review cannot bypass future persistent worker dispatch", async () => {
  const { block } = await seed(); let calls = 0;
  await assert.rejects(reviewAndSaveBlockWeek(user.id, block.id, 1, "2026-09-07", { source: "OPENAI", async review() { calls++; } }, reviewAt), /evaluation-only/);
  assert.equal(calls, 0);
});

const boundaryExpectations = [
  ["primary-success-secondary-poor", "DEVELOPMENT", "PROGRESS", "DEVELOPMENT", [120, 120, 60]],
  ["high-rpe-hold", "DEVELOPMENT", "HOLD", "DEVELOPMENT", [120, 240, 60]],
  ["recover-early", "DEVELOPMENT", "RECOVER_EARLY", "RECOVERY", [0, 120, 60]],
  ["continue-recovery", "RECOVERY", "CONTINUE_RECOVERY", "RECOVERY", [60, 120, 30]],
  ["complete-block", "RECOVERY", "COMPLETE_BLOCK", undefined, [60, 120, 30]],
  ["replan-new-race", "DEVELOPMENT", "REPLAN_BLOCK", undefined, [120, 240, 60]],
];
for (const [id, role, decision, nextRole, reportedMinutes] of boundaryExpectations) {
  test(`boundary fixture ${id} has coherent evidence, roles and reference guidance`, () => {
    const scenario = blockReviewScenarios().find(scenario => scenario.id === id);
    const { context, proposal } = scenario;
    assert.ok(BlockReviewContextSchema.safeParse(context).success);
    assert.equal(context.block.weekRole, role);
    assert.deepEqual(context.block.focuses.map(focus => [focus.sport, focus.capability, focus.role]), [
      ["RUN", "LONG_ENDURANCE", "PRIMARY"], ["BIKE", "THRESHOLD", "SECONDARY"], ["SWIM", "SUSTAINED_ENDURANCE", "MAINTENANCE"],
    ]);
    assert.equal(validateBlockReviewProposal(context, proposal).decision, decision);
    assert.deepEqual(proposal.focusGuidance.map(entry => entry.action), [decision === "PROGRESS" ? "PROGRESS" : "HOLD", "HOLD", "MAINTAIN"]);
    assert.equal(blockReviewRequest(context, proposal).remainingWeekPattern?.[0], nextRole);
    assert.deepEqual(context.evidence.sports, summarizeBlockReviewSports(context.evidence.workouts, context.evidence.activities, true));
    for (const [index, sport] of ["RUN", "BIKE", "SWIM"].entries()) {
      const evidence = context.evidence.sports.find(entry => entry.sport === sport);
      assert.equal(evidence.reportedCompletedPlannedMinutes, reportedMinutes[index]);
      assert.equal(evidence.plannedMinutes, (role === "RECOVERY" ? [60, 120, 30] : [120, 240, 60])[index]);
      assert.equal(evidence.recordedActivityMinutes, null);
      assert.equal(evidence.unlinkedActivityMinutes, 0);
      assert.deepEqual(evidence.activityCoverage, { linkedWorkouts: 0, plannedWorkouts: 2 });
    }
    assert.deepEqual(context.evidence.restrictions, []);
    assert.deepEqual(context.evidence.nextRestrictions, []);
    const workouts = context.evidence.workouts;
    if (id === "primary-success-secondary-poor") {
      assert.ok(workouts.filter(workout => workout.sport === "RUN").every(workout => workout.completion === "COMPLETED" && workout.feedback.rpe === 3));
      assert.equal(workouts[1].completion, "STOPPED"); assert.equal(workouts[1].feedback.rpe, 9);
    }
    if (id === "high-rpe-hold") {
      assert.ok(workouts.every(workout => workout.completion === "COMPLETED"));
      assert.equal(workouts.filter(workout => workout.feedback.rpe >= 8).length, 1);
    }
    if (id === "recover-early") {
      assert.equal(workouts.filter(workout => ["STOPPED", "MODIFIED"].includes(workout.completion)).length, 3);
      assert.equal(workouts.filter(workout => workout.feedback.rpe >= 8).length, 3);
      assert.match(workouts[0].feedback.comment, /persisted across several days/);
    }
    if (role === "RECOVERY") assert.ok(workouts.every(workout => workout.effort === "EASY" && workout.completion === "COMPLETED"));
    if (id === "continue-recovery") assert.ok(workouts.filter(workout => workout.feedback.rpe >= 7).length >= 2);
    if (id === "complete-block") {
      assert.equal(context.block.weekIndex + 1, context.block.plannedWeeks);
      assert.equal(context.block.plannedEndDate, context.effectiveWeekStart);
      assert.ok(workouts.every(workout => workout.feedback.rpe === 3));
    }
    if (id === "replan-new-race") {
      assert.equal(context.planningObjective.mode, "RACE_TARGETED");
      assert.deepEqual(context.block.raceIds, []);
      assert.equal(context.evidence.races[0].goal.distanceMeters, 800);
      assert.equal(context.evidence.races[0].goal.expectedDurationSeconds, 120);
      assert.equal(context.evidence.races[0].goal.importance, 95);
      assert.ok(context.evidence.races[0].goal.date >= context.effectiveWeekStart && context.evidence.races[0].goal.date < "2026-09-21");
      assert.match(context.evidence.notes.join(" "), /block was prescribed for general fitness with no race/);
    }
  });
}

test("boundary CLI names and previous aliases select one fixture each without paid calls", () => {
  assert.deepEqual(blockReviewBoundaryScenarioIds, boundaryExpectations.map(([id]) => id));
  const fixtures = blockReviewScenarios();
  assert.equal(new Set(fixtures.map(scenario => scenario.id)).size, 22);
  for (const id of [...blockReviewBoundaryScenarioIds, ...Object.keys(blockReviewScenarioAliases)]) {
    const result = spawnSync(process.execPath, ["scripts/evaluate-block-reviews.mjs", "--scenario", id], { encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.length, 1);
    assert.equal(output[0].id, blockReviewScenarioAliases[id] ?? id);
    assert.equal(output[0].source, "SIMULATED");
    assert.equal(output[0].calls.length, 0);
  }
});

test("mocked boundary evaluations never send references and show valid alternatives without failing", async () => {
  const originals = blockReviewBoundaryScenarioIds.map(id => blockReviewScenarios().find(scenario => scenario.id === id));
  const fixtures = structuredClone(originals);
  fixtures.forEach(scenario => {
    scenario.proposal.rationale = "REFERENCE_ONLY_GLOBAL_SENTINEL";
    scenario.proposal.focusGuidance.forEach(entry => { entry.rationale = "REFERENCE_ONLY_FOCUS_SENTINEL"; });
  });
  let calls = 0;
  const client = new OpenAI({ apiKey: "fake-boundary-key", maxRetries: 0, fetch: async (_, init) => {
    const body = JSON.parse(init.body);
    const payload = JSON.parse(body.input[0].content);
    assert.deepEqual(Object.keys(payload).sort(), ["correction", "review"]);
    assert.ok(!init.body.includes("REFERENCE_ONLY"));
    assert.equal(payload.review.proposal, undefined);
    assert.equal(payload.review.referenceDecision, undefined);
    assert.equal(payload.review.referenceFocusGuidance, undefined);
    const proposal = calls === 0 ? recommendation("HOLD", payload.review.block.focuses) : originals[calls].proposal;
    calls++;
    return new Response(JSON.stringify({ id: `boundary_${calls}`, model: "mock-review-model", status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(proposal) }] }],
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  const reviewer = createOpenAIBlockReviewer({ provider: "openai", apiKey: "fake-boundary-key", model: "mock-review-model", timeoutMs: 2000, maxOutputTokens: 1000 }, client);
  const results = await evaluateBlockReviews(reviewer, fixtures);
  assert.equal(calls, 6); assert.ok(results.every(result => result.valid));
  assert.equal(results[0].comparison.blockDecision, "DIFFERENT");
  assert.equal(results[0].comparison.focusActions[0].result, "DIFFERENT");
  for (const result of results) {
    const summary = formatBlockReviewSummary(result);
    assert.match(summary, /Model BlockDecision:/); assert.match(summary, /Reference BlockDecision:/);
    assert.match(summary, /Result focus guidance:/); assert.match(summary, /Reference focus guidance:/);
    assert.match(summary, /recorded activity unknown/); assert.match(summary, /UNVERIFIED/);
    assert.match(summary, /Provider calls: 1/); assert.match(summary, /Tokens: 120/);
  }
  assert.match(formatBlockReviewSummary(results[0]), /Reference comparison \(for human review\): block DIFFERENT/);
});

test("invalid evaluator results show unavailable comparisons and remain validation failures", async () => {
  const results = await evaluateBlockReviews({ source: "SIMULATED", async review() { return {}; } }, [blockReviewScenarios()[0]]);
  assert.equal(results[0].valid, false);
  assert.equal(results[0].comparison.blockDecision, "UNAVAILABLE");
  assert.match(formatBlockReviewSummary(results[0]), /BlockDecision: INVALID/);
});

test("22 synthetic review scenarios validate with explicit evidence coverage and focus guidance", async () => {
  const results = await evaluateBlockReviews();
  assert.equal(results.length, 22); assert.ok(results.every(result => result.valid));
  assert.ok(results.every(result => result.proposal.decision === result.referenceDecision));
  const summary = formatBlockReviewSummary(results[0]);
  assert.match(summary, /RUN: planned 120 min; reported completed 120 planned min; recorded activity unknown min/);
  assert.match(summary, /SECONDARY BIKE \/ THRESHOLD -> HOLD/);
  assert.match(summary, /UNVERIFIED/);
  assert.match(summary, /Decision|Review: PROGRESS/);
  assert.ok(!summary.includes("sourceFingerprint"));
});

test("mocked live reviewer uses shared SDK transport, minimal output, correction, and usage metadata", async () => {
  const requests = []; const calls = [];
  const client = new OpenAI({ apiKey: "fake-review-key", maxRetries: 0, fetch: async (_, init) => {
    const body = JSON.parse(init.body); requests.push(body);
    const payload = JSON.parse(body.input[0].content);
    assert.equal(payload.review.athleteId, undefined); assert.equal(payload.review.sourceFingerprint, undefined);
    assert.equal(payload.review.block.focuses[0].progressionStrategy, "LONG_SESSION");
    if (requests.length === 2) assert.equal(payload.correction.errors[0].code, "REVIEW_ROLE");
    return new Response(JSON.stringify({ id: `review_${requests.length}`, model: "gpt-5.6-luna", status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(recommendation(requests.length === 1 ? "CONTINUE_RECOVERY" : "PROGRESS", payload.review.block.focuses)) }] }],
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 0 } },
    }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  const reviewer = createOpenAIBlockReviewer({ provider: "openai", apiKey: "fake-review-key", model: "gpt-5.6-luna", timeoutMs: 2000, maxOutputTokens: 1000 }, client);
  const result = await generateBlockReview(blockReviewScenarios()[0].context, reviewer, { reportCall: async call => { calls.push(call); } });
  assert.equal(result.decision, "PROGRESS"); assert.equal(requests.length, 2); assert.equal(calls.length, 2);
  assert.deepEqual(Object.keys(requests[0].text.format.schema.properties).sort(), ["decision", "focusGuidance", "rationale"]);
  assert.equal(requests[0].store, false);
  assert.match(BLOCK_REVIEW_INSTRUCTIONS, /missing data is not a\s+universal HOLD rule/);
});

test("planned, reported, unlinked and partial/full linked evidence stay distinct", () => {
  const scenarios = blockReviewScenarios();
  const run = id => scenarios.find(scenario => scenario.id === id).context.evidence.sports.find(sport => sport.sport === "RUN");
  assert.equal(run("successful-run-block").reportedCompletedPlannedMinutes, 120);
  assert.equal(run("successful-run-block").recordedActivityMinutes, null);
  assert.equal(run("primary-long-session").unlinkedActivityMinutes, 120);
  assert.equal(run("primary-long-session").recordedActivityMinutes, null);
  assert.equal(run("partially-linked").recordedActivityMinutes, 58);
  assert.deepEqual(run("partially-linked").activityCoverage, { linkedWorkouts: 1, plannedWorkouts: 2 });
  assert.equal(run("fully-linked").recordedActivityMinutes, 118);
  assert.equal(run("fully-linked").reportedCompletedPlannedMinutes, 120);
  assert.deepEqual(run("fully-linked").activityCoverage, { linkedWorkouts: 2, plannedWorkouts: 2 });
  const evidence = structuredClone(scenarios.find(scenario => scenario.id === "fully-linked").context.evidence);
  evidence.workouts[0].completion = "MODIFIED";
  const totals = summarizeBlockReviewSports(evidence.workouts, evidence.activities, true).find(sport => sport.sport === "RUN");
  assert.equal(totals.reportedCompletedPlannedMinutes, 60);
  assert.equal(totals.recordedActivityMinutes, 118);
  assert.equal(totals.recordedActivitySessions, 2);
  assert.equal(totals.recordedLongestMinutes, 60);
});

test("evidence rejects invented totals, duplicate records and unrelated activity links", () => {
  const evidence = blockReviewScenarios().find(scenario => scenario.id === "fully-linked").context.evidence;
  for (const change of [copy => { copy.sports[0].recordedActivityMinutes = 999; },
    copy => { copy.activities[0].workoutId = "unowned-workout"; },
    copy => { copy.activities[0].workoutId = copy.workouts[1].id; },
    copy => { copy.activities.push(copy.activities[0]); },
    copy => { copy.activityLinkingAvailable = false; }]) {
    const copy = structuredClone(evidence); change(copy);
    assert.equal(BlockReviewEvidenceSchema.safeParse(copy).success, false);
  }
});

test("focus guidance requires complete identity coverage and respects maintenance and lifecycle", () => {
  const { context, proposal } = blockReviewScenarios()[0];
  assert.deepEqual(validateBlockReviewProposal(context, proposal).focusGuidance.map(entry => entry.action), ["PROGRESS", "HOLD", "MAINTAIN"]);
  assert.equal(validateBlockReviewProposal(context, { ...proposal, decision: "HOLD",
    rationale: "Hold broader development; the explicitly reported successful primary stimulus permits a narrow exception." }).focusGuidance[0].action, "PROGRESS");
  const both = blockReviewScenarios().find(scenario => scenario.id === "both-focuses-progress");
  assert.deepEqual(validateBlockReviewProposal(both.context, both.proposal).focusGuidance.map(entry => entry.action), ["PROGRESS", "PROGRESS", "MAINTAIN"]);
  for (const change of [copy => { delete copy.focusGuidance; }, copy => { copy.focusGuidance.pop(); },
    copy => { copy.focusGuidance[1] = copy.focusGuidance[0]; }, copy => { copy.focusGuidance[0].capability = "INVENTED"; },
    copy => { copy.focusGuidance[2].action = "PROGRESS"; }, copy => { copy.focusGuidance[0].action = "HOLD"; },
    copy => { copy.focusGuidance[0].durationMinutes = 70; }]) {
    const copy = structuredClone(proposal); change(copy);
    assert.throws(() => validateBlockReviewProposal(context, copy));
  }
  for (const id of ["recover-early", "continue-recovery", "complete-block", "replan-new-race"]) {
    const scenario = blockReviewScenarios().find(scenario => scenario.id === id);
    const invalid = structuredClone(scenario.proposal); invalid.focusGuidance[0].action = "PROGRESS";
    assert.throws(() => validateBlockReviewProposal(scenario.context, invalid), /Recovery and terminal/);
    assert.ok(!scenario.proposal.focusGuidance.some(entry => entry.action === "PROGRESS"));
  }
});

test("per-focus guidance reaches the next weekly input and previous guidance stays immutable", async () => {
  const scenario = blockReviewScenarios()[0];
  const { block } = await seed(undefined, scenario.context.block.focuses);
  const first = await saveReview(block, "PROGRESS");
  const context = await buildPlanningContext(user.id, { now: reviewAt, weekStart: "2026-09-14" });
  const input = buildOpenAIPlanningInput({ version: 1, context, fromDate: "2026-09-14", protectedWorkouts: [] });
  assert.deepEqual(input.developmentBlock.previousReview.request.focusGuidance.map(entry => entry.action), ["PROGRESS", "HOLD", "MAINTAIN"]);
  assert.equal(input.developmentBlock.previousReview.evidence, undefined);
  const second = await saveReview(first, "HOLD");
  assert.deepEqual(second.reviews[0], first.reviews[0]);
  assert.deepEqual(second.reviews[1].request.focusGuidance.map(entry => entry.action), ["HOLD", "HOLD", "MAINTAIN"]);
});

test("legacy actualMinutes and missing guidance remain historical, not converted to linked execution", async () => {
  const { block } = await seed();
  const first = await saveReview(block, "HOLD");
  const legacy = structuredClone(first.reviews[0]);
  delete legacy.request.focusGuidance;
  legacy.source.version = "block-review-v1";
  legacy.evidence.version = 1;
  legacy.evidence.activities = legacy.evidence.activities.map(({ workoutId, ...activity }) => activity);
  legacy.evidence.sports = legacy.evidence.sports.map(sport => ({ sport: sport.sport, plannedMinutes: sport.plannedMinutes,
    plannedSessions: sport.plannedSessions, plannedLongestMinutes: sport.plannedLongestMinutes,
    actualMinutes: sport.unlinkedActivityMinutes, actualSessions: sport.unlinkedActivitySessions,
    actualLongestMinutes: sport.plannedLongestMinutes, reportedCompletedSessions: sport.reportedCompletedSessions }));
  legacy.response.sports = legacy.evidence.sports.map(sport => ({ sport: sport.sport, plannedMinutes: sport.plannedMinutes,
    plannedSessions: sport.plannedSessions, activityMinutes: sport.actualMinutes, activitySessions: sport.actualSessions,
    longestMinutes: sport.actualLongestMinutes, reportedCompletedSessions: sport.reportedCompletedSessions }));
  assert.ok(BlockReviewSchema.safeParse(legacy).success);
  const { id, revision, createdAt, ...content } = legacy;
  await prisma.developmentBlockReview.update({ where: { id }, data: { content } });
  const restored = await getDevelopmentBlock(user.id, block.id);
  assert.deepEqual(restored.reviews[0], legacy);
  const current = await saveReview(restored, "PROGRESS");
  assert.deepEqual(current.reviews[0], legacy);
  assert.equal(current.reviews[1].evidence.version, 2);
  assert.equal(current.reviews[1].evidence.sports[0].recordedActivityMinutes, null);
});

test("focus IDs are stable, order-independent and resolve only authoritative metadata", () => {
  const { context, proposal } = blockReviewScenarios().find(scenario => scenario.id === "continue-recovery");
  const ids = context.block.focuses.map(developmentFocusId);
  assert.deepEqual(ids, ["RUN:LONG_ENDURANCE", "BIKE:THRESHOLD", "SWIM:SUSTAINED_ENDURANCE"]);
  assert.deepEqual(context.block.focuses.map(focus => developmentFocusId({ ...focus, rationale: "Changed text" })), ids);
  const changed = structuredClone(context); changed.block.revision++; changed.block.weekIndex++;
  assert.deepEqual(changed.block.focuses.map(developmentFocusId), ids);
  const reversed = { ...proposal, focusGuidance: [...proposal.focusGuidance].reverse() };
  assert.equal(validateBlockReviewProposal(context, reversed).decision, "CONTINUE_RECOVERY");
  const resolved = blockReviewRequest(context, reversed).focusGuidance;
  for (const entry of resolved) {
    const focus = context.block.focuses.find(focus => developmentFocusId(focus) === entry.focusId);
    assert.deepEqual({ sport: entry.sport, capability: entry.capability, role: entry.role, progressionStrategy: entry.progressionStrategy },
      { sport: focus.sport, capability: focus.capability, role: focus.role, progressionStrategy: focus.progressionStrategy });
  }
  assert.deepEqual(resolveFocusGuidance(context.block.focuses, proposal.focusGuidance).map(entry => entry.action), ["HOLD", "HOLD", "MAINTAIN"]);
});

test("missing, unknown, duplicate and extra IDs fail with exact allowed-ID corrections", () => {
  const { context, proposal } = blockReviewScenarios()[0];
  for (const [label, change] of [
    ["missing", copy => { copy.focusGuidance.pop(); }],
    ["duplicate", copy => { copy.focusGuidance[1].focusId = copy.focusGuidance[0].focusId; }],
    ["unknown", copy => { copy.focusGuidance[0].focusId = "invented-focus"; }],
    ["extra", copy => { copy.focusGuidance.push({ focusId: "extra-focus", action: "HOLD", rationale: "Extra" }); }],
    ["empty", copy => { copy.focusGuidance = []; }],
    ["missing field", copy => { delete copy.focusGuidance[0].focusId; }],
  ]) {
    const copy = structuredClone(proposal); change(copy);
    assert.throws(() => validateBlockReviewProposal(context, copy), error => {
      const messages = error.issues.map(issue => issue.message).join(" ");
      for (const focus of context.block.focuses) assert.ok(messages.includes(developmentFocusId(focus)), label);
      assert.match(messages, /exactly one guidance item per focus ID/);
      return true;
    });
  }
  for (const field of ["sport", "capability", "role", "progressionStrategy"]) {
    const copy = structuredClone(proposal); copy.focusGuidance[0][field] = "MODEL_OVERRIDE";
    assert.equal(BlockReviewProposalSchema.safeParse(copy).success, false);
  }
});

test("mocked continue-recovery corrects focus IDs through the same bounded proposal loop", async () => {
  const scenario = blockReviewScenarios().find(scenario => scenario.id === "continue-recovery");
  const expectedIds = scenario.context.block.focuses.map(developmentFocusId);
  let calls = 0;
  const client = new OpenAI({ apiKey: "fake-identity-key", maxRetries: 0, fetch: async (_, init) => {
    calls++;
    const body = JSON.parse(init.body); const payload = JSON.parse(body.input[0].content);
    assert.deepEqual(payload.review.block.focuses.map(focus => focus.focusId), expectedIds);
    const guidanceSchema = body.text.format.schema.properties.focusGuidance;
    assert.deepEqual(Object.keys(guidanceSchema.items.properties).sort(), ["action", "focusId", "rationale"]);
    assert.deepEqual(guidanceSchema.items.properties.focusId.enum, expectedIds);
    assert.equal(guidanceSchema.minItems, 3); assert.equal(guidanceSchema.maxItems, 3);
    if (calls > 1) {
      assert.deepEqual(payload.correction.allowedFocusIds, expectedIds);
      assert.match(payload.correction.instructions, /Do not rename, omit, duplicate, or create IDs/);
      assert.ok(payload.correction.errors.some(error => error.code === "FOCUS_GUIDANCE"));
    }
    const response = structuredClone(scenario.proposal);
    if (calls === 1) response.focusGuidance[0].focusId = "wrong-focus";
    if (calls === 2) response.focusGuidance.pop();
    return new Response(JSON.stringify({ id: `focus_response_${calls}`, model: "mock-model", status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(response) }] }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  const reviewer = createOpenAIBlockReviewer({ provider: "openai", apiKey: "fake-identity-key", model: "mock-model", timeoutMs: 2000, maxOutputTokens: 1000 }, client);
  const [result] = await evaluateBlockReviews(reviewer, [scenario]);
  assert.equal(calls, 3); assert.equal(result.valid, true);
  assert.equal(result.proposal.decision, "CONTINUE_RECOVERY");
  assert.equal(result.request.remainingWeekPattern[0], "RECOVERY");
  assert.match(formatBlockReviewSummary(result), /PRIMARY RUN \/ LONG_ENDURANCE -> HOLD/);
  assert.equal(result.comparison.blockDecision, "MATCH");
  let invalidCalls = 0;
  await assert.rejects(generateBlockReview(scenario.context, { source: "SIMULATED", async review() { invalidCalls++; return { ...scenario.proposal, focusGuidance: [] }; } }));
  assert.equal(invalidCalls, 3);
});

test("new review identity persists and reaches weekly context; tampered metadata is rejected", async () => {
  const scenario = blockReviewScenarios()[0];
  const { block } = await seed(undefined, scenario.context.block.focuses);
  const reviewed = await saveReview(block, "PROGRESS");
  assert.equal(reviewed.reviews[0].source.version, "block-review-v3");
  const saved = reviewed.reviews[0].request.focusGuidance;
  assert.deepEqual(saved, resolveFocusGuidance(block.proposal.focuses, recommendation("PROGRESS", block.proposal.focuses).focusGuidance));
  const context = await buildPlanningContext(user.id, { now: reviewAt, weekStart: "2026-09-14" });
  assert.deepEqual(context.developmentBlock.previousReview.request.focusGuidance, saved);
  const input = buildOpenAIPlanningInput({ version: 1, context, fromDate: "2026-09-14", protectedWorkouts: [] });
  assert.deepEqual(input.developmentBlock.previousReview.request.focusGuidance, saved);
  const bad = structuredClone(reviewed.reviews[0].request); bad.focusGuidance[0].role = "SECONDARY";
  await assert.rejects(recordBlockReview(user.id, block.id, reviewed.revision, bad, reviewAt), /metadata differs/);
  assert.equal((await getDevelopmentBlock(user.id, block.id)).reviews.length, 1);
});

test("legacy sport/capability guidance resolves for planning without rewriting its stored history", async () => {
  const { block } = await seed();
  const first = await saveReview(block, "HOLD");
  const legacy = structuredClone(first.reviews[0]);
  legacy.source.version = "block-review-v2";
  legacy.request.focusGuidance = legacy.request.focusGuidance.map(({ focusId, role, progressionStrategy, ...entry }) => entry);
  const { id, revision, createdAt, ...content } = legacy;
  await prisma.developmentBlockReview.update({ where: { id }, data: { content } });
  const read = await getDevelopmentBlock(user.id, block.id);
  assert.deepEqual(read.reviews[0], legacy);
  const context = await buildPlanningContext(user.id, { now: reviewAt, weekStart: "2026-09-14" });
  assert.equal(context.developmentBlock.previousReview.request.focusGuidance[0].focusId, "RUN:LONG_ENDURANCE");
  assert.equal(context.developmentBlock.previousReview.request.focusGuidance[0].progressionStrategy, "LONG_SESSION");
  const next = await saveReview(read, "PROGRESS");
  assert.deepEqual(next.reviews[0], legacy);
});

test("week roles remain authoritative and evidence discipline is explicit in both prompts", () => {
  const scenario = blockReviewScenarios()[0];
  for (const role of ["RECOVERY", "TAPER", "RACE", "RETURN"]) {
    const context = structuredClone(scenario.context); context.remainingWeekPattern[0] = role;
    assert.equal(blockReviewRequest(context, scenario.proposal).remainingWeekPattern[0], role);
  }
  assert.match(PLANNER_INSTRUCTIONS, /Week role remains authoritative/);
  assert.match(PLANNER_INSTRUCTIONS, /Global PROGRESS is not permission to progress every focus/);
  assert.match(PLANNER_INSTRUCTIONS, /MAINTAIN provides/);
  assert.match(BLOCK_REVIEW_INSTRUCTIONS, /missing recovery data does not mean good recovery/);
  assert.match(BLOCK_REVIEW_INSTRUCTIONS, /reportedCompletedPlannedMinutes sums the PRESCRIBED/);
  assert.match(BLOCK_REVIEW_INSTRUCTIONS, /there is no\s+one-focus limit/);
  assert.ok(blockReviewScenarios()[0].context.evidence.workouts.every(workout => !workout.feedback.comment.includes("recovery")));
});

test("purposeful construction and title guidance remain soft, with no universal cooldown cap", () => {
  assert.match(PLANNER_INSTRUCTIONS, /Design the primary stimulus first/);
  assert.match(PLANNER_INSTRUCTIONS, /HOLD does not require an identical week/);
  assert.match(PLANNER_INSTRUCTIONS, /Do not change useful intensity solely/);
  const input = planningScenarios().find(scenario => scenario.id === "general-fitness-active-block").input;
  const segment = (label, seconds, lower, upper) => ({ label, seconds, instructions: label, target: { metric: "FTP_PERCENT", lower, upper } });
  const workout = { kind: "WORKOUT", id: "construction", date: input.fromDate, sport: "BIKE", title: "Sustained sub-threshold work", templateId: null,
    effort: "HARD", optional: false, explanation: "Schema-valid example, not a recommended construction.", durationMinutes: 120,
    blocks: [{ repeat: 1, segments: [segment("Warm-up", 900, 50, 65)] },
      { repeat: 4, segments: [segment("Work", 720, 88, 92), segment("Recovery", 360, 50, 60)] },
      { repeat: 1, segments: [segment("Cool-down", 1980, 45, 55)] }],
  };
  assert.equal(finalizePlanProposal(input, { version: 1, explanation: "No hard construction cap", workouts: [workout] }).totalMinutes, 120);
});
