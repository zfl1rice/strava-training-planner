import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import {
  BlockReviewRequestSchema, DevelopmentBlockProposalSchema, DevelopmentFocusSchema,
  ActiveDevelopmentBlockSchema, BlockWeekRoleSchema, ProgressionStrategySchema, TrainingPhaseSchema,
  PlanningContextSchema, activeBlockForWeek, blockWeekPattern, deterministicBlockPlanner,
  deterministicPlanProvider, validateBlockProposal, calendarMonday, addCalendarDays,
  emptyAthleteProfile,
} from "@pkg/shared";
import {
  prisma, buildPlanningContext, buildBlockPlanningContext, createDevelopmentBlock, getDevelopmentBlock,
  getActiveDevelopmentBlock, recordBlockReview, StaleBlockGenerationError,
  saveWeeklyGoals, saveAthleteProfile, saveWorkoutStates, createRaceGoal, generateAndSaveFlexiblePlan,
  createOrReusePlanRun, executePlanRun,
} from "@pkg/db";
import { buildOpenAIPlanningInput, PLANNER_INSTRUCTIONS } from "../apps/worker/src/planner-prompt.ts";

assert.match(process.env.OAUTH_TEST_DATABASE ?? "", /^planner_oauth_test_[a-f0-9]{16}$/);
assert.equal(new URL(process.env.DATABASE_URL).pathname, `/${process.env.OAUTH_TEST_DATABASE}`);
const now = new Date("2026-09-06T12:00:00Z");
const direction = (extra = {}) => ({ startDate: "2026-09-07", phase: "BUILD", rationale: "Explicit development direction.", raceIds: [], ...extra });
const focus = (extra = {}) => ({ sport: "RUN", capability: "LONG_ENDURANCE", role: "PRIMARY", progressionStrategy: "LONG_SESSION", rationale: "Supplied run durability emphasis.", ...extra });
const review = (decision, extra = {}) => ({ reviewedWeekStart: "2026-09-07", effectiveWeekStart: "2026-09-14", decision, rationale: "Explicit athlete response supports this decision.", ...extra });
const reviewNow = new Date("2026-09-13T12:00:00Z");
const race = (extra = {}) => ({ name: "70.3", date: "2026-11-01", importance: 95, sports: ["SWIM", "BIKE", "RUN"], eventType: "TRIATHLON", distanceMeters: null, expectedDurationSeconds: null, performanceGoal: null, demandProfile: null, ...extra });
let user;
beforeEach(async () => {
  await prisma.activity.deleteMany();
  await prisma.jobRun.deleteMany();
  await prisma.user.deleteMany();
  user = await prisma.user.create({ data: {} });
  await saveWeeklyGoals(user.id, { RUN: 120, BIKE: 240, SWIM: 60 });
});
after(async () => { await prisma.$disconnect(); });
const create = (extra = {}, options = {}, provider) => createDevelopmentBlock(user.id, direction(extra), { now, ...options }, provider);

test("controlled focus vocabulary, roles, strategies, and calendar dates reject malformed proposals", () => {
  for (const progressionStrategy of ProgressionStrategySchema.options) assert.ok(DevelopmentFocusSchema.safeParse(focus({ progressionStrategy })).success);
  for (const role of ["PRIMARY", "SECONDARY", "MAINTENANCE"]) assert.ok(DevelopmentFocusSchema.safeParse(focus({ role, progressionStrategy: "MAINTAIN" })).success);
  assert.equal(DevelopmentFocusSchema.safeParse(focus({ capability: "MADE_UP" })).success, false);
  assert.equal(DevelopmentFocusSchema.safeParse(focus({ role: "MAINTENANCE" })).success, false);
  const proposal = { version: 1, ...direction(), focuses: [focus()], weekPattern: ["DEVELOPMENT"] };
  assert.ok(DevelopmentBlockProposalSchema.safeParse(proposal).success);
  assert.equal(DevelopmentBlockProposalSchema.safeParse({ ...proposal, startDate: "2026-09-08" }).success, false);
  assert.equal(DevelopmentBlockProposalSchema.safeParse({ ...proposal, focuses: [focus(), focus()] }).success, false);
  assert.equal(DevelopmentBlockProposalSchema.safeParse({ ...proposal, weekPattern: [] }).success, false);
  for (const phase of TrainingPhaseSchema.options) assert.ok(DevelopmentBlockProposalSchema.safeParse({ ...proposal, phase }).success);
  for (const role of BlockWeekRoleSchema.options) assert.ok(DevelopmentBlockProposalSchema.safeParse({ ...proposal, weekPattern: [role] }).success);
});

test("general fitness creates one persistent block and reuses it without another provider call", async () => {
  const block = await create();
  assert.equal(block.status, "ACTIVE");
  assert.deepEqual(block.proposal.weekPattern, ["DEVELOPMENT", "DEVELOPMENT", "DEVELOPMENT", "RECOVERY"]);
  assert.equal((await buildBlockPlanningContext(user.id, direction(), now)).planningObjective.mode, "GENERAL_FITNESS");
  const reused = await create({}, {}, { createBlock() { throw new Error("Must reuse"); } });
  assert.equal(reused.id, block.id);
  assert.equal(await prisma.developmentBlock.count(), 1);
});

test("2+1 and 4+1 patterns are accepted; recovery and taper are distinct", async () => {
  for (const count of [2, 4]) {
    const context = await buildBlockPlanningContext(user.id, direction({ weekPattern: [...Array(count).fill("DEVELOPMENT"), "RECOVERY"] }), now);
    assert.equal(validateBlockProposal(context, await deterministicBlockPlanner.createBlock(context)).weekPattern.length, count + 1);
  }
  const recovery = await create({ phase: "RECOVERY_TRANSITION", weekPattern: ["RECOVERY", "RETURN"] });
  assert.equal(activeBlockForWeek(recovery, "2026-09-07").weekRole, "RECOVERY");
  assert.equal(activeBlockForWeek(recovery, "2026-09-14").weekRole, "RETURN");
  assert.notEqual(activeBlockForWeek(recovery, "2026-09-07").weekRole, "TAPER");
});

test("active strategy reaches weekly input with correct week index, phase, and immutable saved provenance", async () => {
  const block = await create({ focuses: [focus()] });
  const context = await buildPlanningContext(user.id, { now });
  assert.equal(context.developmentBlock.id, block.id);
  assert.equal(context.developmentBlock.weekIndex, 0);
  assert.equal(context.seasonPhase, "BUILD");
  const prompt = buildOpenAIPlanningInput({ version: 1, context, fromDate: "2026-09-07", protectedWorkouts: [] });
  assert.deepEqual(prompt.developmentBlock.focuses, [focus()]);
  assert.match(PLANNER_INSTRUCTIONS, /not a blanket|never a blanket/);
  const plan = await generateAndSaveFlexiblePlan(user.id, now);
  await recordBlockReview(user.id, block.id, block.revision, review("HOLD"), reviewNow);
  const stored = await prisma.weeklyPlan.findUniqueOrThrow({ where: { id: plan.id } });
  assert.equal(stored.content.developmentBlock.revision, 1);
  assert.equal((await buildPlanningContext(user.id, { now: reviewNow })).developmentBlock.revision, 2);
});

test("old context snapshots and weekly generation remain valid without a block", async () => {
  const context = await buildPlanningContext(user.id, { now });
  delete context.developmentBlock;
  delete context.seasonPhase;
  const parsed = PlanningContextSchema.parse(context);
  assert.equal(parsed.developmentBlock, null);
  assert.equal(parsed.seasonPhase, null);
  assert.ok((await generateAndSaveFlexiblePlan(user.id, now)).content.days.length);
});

test("week outside the block is marked for review instead of repeating a cycle", async () => {
  const block = await create({ weekPattern: ["DEVELOPMENT"] });
  const value = activeBlockForWeek(block, "2026-09-14");
  assert.equal(value.weekIndex, null);
  assert.equal(value.weekRole, null);
  assert.equal(ActiveDevelopmentBlockSchema.safeParse({ ...value, weekIndex: 12, weekRole: "DEVELOPMENT" }).success, false);
  const context = await buildPlanningContext(user.id, { now, weekStart: "2026-09-14" });
  assert.match(context.dataQuality.notes.join(" "), /does not cover/);
});

test("explicit progress and hold decisions persist without changing goals or baselines", async () => {
  for (const decision of ["PROGRESS", "HOLD"]) {
    const block = await getActiveDevelopmentBlock(user.id) ?? await create();
    const result = await recordBlockReview(user.id, block.id, block.revision, review(decision), reviewNow);
    const context = await buildPlanningContext(user.id, { now: reviewNow });
    assert.equal(context.developmentBlock.previousReview.request.decision, decision);
    assert.equal(context.goals.RUN, 120);
    assert.equal(context.fitness.effective.cycling.value, null);
    assert.equal(result.reviews.length, result.revision - 1);
  }
});

test("early and extended recovery append future changes, retaining original proposal and earlier weeks", async () => {
  const block = await create();
  const early = await recordBlockReview(user.id, block.id, 1, review("RECOVER_EARLY", { remainingWeekPattern: ["RECOVERY"] }), reviewNow);
  assert.deepEqual(early.proposal, block.proposal);
  assert.deepEqual(blockWeekPattern(early), ["DEVELOPMENT", "RECOVERY"]);
  assert.equal(activeBlockForWeek(early, "2026-09-07").previousReview, null);
  const extended = await recordBlockReview(user.id, block.id, 2, review("CONTINUE_RECOVERY", {
    reviewedWeekStart: "2026-09-14", effectiveWeekStart: "2026-09-21", remainingWeekPattern: ["RECOVERY", "RETURN"],
  }), new Date("2026-09-20T12:00:00Z"));
  assert.deepEqual(blockWeekPattern(extended), ["DEVELOPMENT", "RECOVERY", "RECOVERY", "RETURN"]);
  assert.equal(extended.reviews.length, 2);
});

test("reviews reject retroactive edits, stale revisions, missing recovery patterns, and wrong lifecycle", async () => {
  const block = await create();
  assert.equal(BlockReviewRequestSchema.safeParse(review("RECOVER_EARLY")).success, false);
  await assert.rejects(recordBlockReview(user.id, block.id, 9, review("HOLD"), reviewNow), StaleBlockGenerationError);
  await assert.rejects(recordBlockReview(user.id, block.id, 1, review("CONTINUE_RECOVERY", { remainingWeekPattern: ["RECOVERY"] }), reviewNow), /requires a recovery/);
  await assert.rejects(recordBlockReview(user.id, block.id, 1, review("HOLD"), new Date("2026-09-22T12:00:00Z")), /current or future/);
  const completed = await recordBlockReview(user.id, block.id, 1, review("COMPLETE_BLOCK"), reviewNow);
  await assert.rejects(recordBlockReview(user.id, block.id, 2, review("HOLD"), reviewNow), /Historical/);
  assert.equal((await getDevelopmentBlock(user.id, block.id)).status, "COMPLETED");
  assert.deepEqual((await getDevelopmentBlock(user.id, block.id)).proposal, completed.proposal);
});

test("a late completion is allowed without silently extending the expired block", async () => {
  const block = await create({ weekPattern: ["DEVELOPMENT"] });
  const completed = await recordBlockReview(user.id, block.id, 1, review("COMPLETE_BLOCK", { effectiveWeekStart: "2026-11-02" }), new Date("2026-11-01T12:00:00Z"));
  assert.equal(completed.status, "COMPLETED");
  assert.equal(blockWeekPattern(completed).length, 1);
});

test("block completion permits another general-fitness emphasis without inventing a weakness", async () => {
  const first = await create();
  await recordBlockReview(user.id, first.id, 1, review("COMPLETE_BLOCK"), reviewNow);
  const second = await create({ startDate: "2026-09-14" }, { now: reviewNow });
  assert.notEqual(second.id, first.id);
  assert.notEqual(second.proposal.focuses.find(value => value.role === "PRIMARY").sport, first.proposal.focuses.find(value => value.role === "PRIMARY").sport);
  assert.match(second.proposal.focuses[0].rationale, /not a diagnosed weakness|Maintain/);
});

test("material replan preserves the previous block and requires the current revision", async () => {
  const first = await create();
  await assert.rejects(create({}, { mode: "REPLAN", expectedBlock: { id: first.id, revision: 9 } }), StaleBlockGenerationError);
  const second = await create({ focuses: [focus({ sport: "BIKE", capability: "THRESHOLD", progressionStrategy: "TIME_AT_INTENSITY" })] }, { mode: "REPLAN", expectedBlock: { id: first.id, revision: 1 } });
  assert.equal((await getDevelopmentBlock(user.id, first.id)).status, "ABORTED");
  assert.deepEqual((await getDevelopmentBlock(user.id, first.id)).proposal, first.proposal);
  assert.equal((await getActiveDevelopmentBlock(user.id)).id, second.id);
});

test("REPLAN_BLOCK review records a decision without automatically calling a provider", async () => {
  const first = await create();
  const result = await recordBlockReview(user.id, first.id, 1, review("REPLAN_BLOCK"), reviewNow);
  assert.equal(result.status, "ABORTED");
  assert.equal(await getActiveDevelopmentBlock(user.id), null);
  assert.equal(await prisma.developmentBlock.count(), 1);
});

test("block ownership and race ownership are enforced", async () => {
  const first = await create();
  const other = await prisma.user.create({ data: {} });
  assert.equal(await getDevelopmentBlock(other.id, first.id), null);
  await assert.rejects(recordBlockReview(other.id, first.id, 1, review("HOLD"), reviewNow), /not found/);
  const foreignRace = await createRaceGoal(other.id, race());
  await assert.rejects(create({ raceIds: [foreignRace] }, { mode: "REPLAN", expectedBlock: { id: first.id, revision: 1 } }), /references a race/);
});

test("competing races and explicit different capability priorities reach block and weekly planners", async () => {
  const longRace = await createRaceGoal(user.id, race());
  const shortRace = await createRaceGoal(user.id, race({ name: "Two-minute event", date: "2026-10-01", importance: 90, sports: ["BIKE"], expectedDurationSeconds: 120 }));
  const block = await create({ raceIds: [shortRace, longRace], focuses: [
    focus({ sport: "BIKE", capability: "TWO_TO_FIVE_MINUTE_POWER", progressionStrategy: "REPETITIONS" }),
    focus({ role: "SECONDARY" }),
  ] });
  const context = await buildBlockPlanningContext(user.id, direction(), now);
  assert.equal(context.races.length, 2);
  assert.equal(context.planningObjective.mode, "RACE_TARGETED");
  assert.deepEqual(block.proposal.raceIds, [shortRace, longRace]);
  assert.equal((await buildPlanningContext(user.id, { now })).developmentBlock.focuses[0].capability, "TWO_TO_FIVE_MINUTE_POWER");
});

test("taper requires a real event; recent past races remain available for transition context", async () => {
  await assert.rejects(create({ phase: "TAPER" }), /referenced event/);
  const event = await createRaceGoal(user.id, race({ date: "2026-09-13" }));
  const block = await create({ phase: "TAPER", raceIds: [event], focuses: [focus()] });
  assert.equal(activeBlockForWeek(block, "2026-09-07").weekRole, "TAPER");
  const context = await buildBlockPlanningContext(user.id, direction({ startDate: "2026-09-14", phase: "RECOVERY_TRANSITION" }), new Date("2026-09-14T12:00:00Z"));
  assert.equal(context.planningObjective.mode, "GENERAL_FITNESS");
  assert.equal(context.races[0].id, event);
});

test("stale asynchronous block generation cannot replace newer strategy", async () => {
  const entered = Promise.withResolvers(); const release = Promise.withResolvers();
  const pending = create({}, {}, { async createBlock(context) { entered.resolve(); await release.promise; return deterministicBlockPlanner.createBlock(context); } });
  await entered.promise;
  const winner = await create({ focuses: [focus()] });
  release.resolve();
  await assert.rejects(pending, StaleBlockGenerationError);
  assert.equal((await getActiveDevelopmentBlock(user.id)).id, winner.id);
  assert.equal(await prisma.developmentBlock.count(), 1);
});

test("profile edits invalidate in-flight block planning without changing saved athlete data", async () => {
  const entered = Promise.withResolvers(); const release = Promise.withResolvers();
  const pending = create({}, {}, { async createBlock(context) { entered.resolve(); await release.promise; return deterministicBlockPlanner.createBlock(context); } });
  await entered.promise;
  const profile = emptyAthleteProfile();
  profile.availability.overrides.push({ date: "2026-10-01", settings: { availableMinutes: 0, maxSessions: 0, allowedSports: [], poolAccess: false }, note: "Travel" });
  await saveAthleteProfile(user.id, profile, "UTC");
  release.resolve();
  await assert.rejects(pending, StaleBlockGenerationError);
  assert.equal(await getActiveDevelopmentBlock(user.id), null);
});

test("block change cancels an in-flight weekly job using existing snapshot guards", async () => {
  const currentNow = new Date();
  const startDate = addCalendarDays(calendarMonday(currentNow.toISOString().slice(0, 10)), 7);
  const run = await createOrReusePlanRun(user.id, { scope: "NEXT_WEEK" });
  const entered = Promise.withResolvers(); const release = Promise.withResolvers();
  const running = executePlanRun(run.id, async input => { entered.resolve(); await release.promise; return deterministicPlanProvider(input); });
  await entered.promise;
  try { await createDevelopmentBlock(user.id, direction({ startDate })); }
  finally { release.resolve(); }
  assert.equal((await running).status, "CANCELLED");
  assert.equal(await prisma.weeklyPlan.count(), 0);
});

test("review evidence records actual vs planned separately and leaves comments uninterpreted", async () => {
  const block = await create();
  const saved = await generateAndSaveFlexiblePlan(user.id, now);
  const workout = saved.content.days.find(day => day.kind === "WORKOUT");
  const comment = "I felt flat after travel and poor sleep; the session felt too hard.";
  await saveWorkoutStates(user.id, saved.id, saved.updatedAt, [{ workoutId: workout.id, date: workout.date,
    templateId: workout.templateId ?? "custom", locked: false, completion: "STOPPED", feedback: { rpe: 9, comment } }]);
  await prisma.activity.create({ data: { userId: user.id, type: "RUN", startedAt: new Date("2026-09-09T12:00:00Z"), durationSeconds: 1800, source: "MANUAL" } });
  const result = await recordBlockReview(user.id, block.id, 1, review("HOLD"), new Date("2026-09-14T12:00:00Z"));
  const run = result.reviews[0].response.sports.find(value => value.sport === "RUN");
  assert.equal(run.activityMinutes, 30);
  assert.ok(run.plannedMinutes > 0);
  assert.equal(run.reportedCompletedSessions, 0);
  assert.equal(result.reviews[0].response.feedback[0].comment, comment);
  assert.equal(result.reviews[0].response.feedback[0].rpe, 9);
  assert.equal(result.reviews[0].request.rationale, review("HOLD").rationale);
});

test("Postgres prevents two active blocks even if a writer bypasses the service", async () => {
  const block = await create();
  await assert.rejects(prisma.developmentBlock.create({ data: { userId: user.id, content: block.proposal,
    phase: block.proposal.phase, startDate: new Date("2026-09-07"), plannedEndDate: new Date("2026-10-05") } }),
  error => error.code === "P2002");
});

test("a changed race invalidates a pending replan and preserves the old active block", async () => {
  const first = await create();
  const entered = Promise.withResolvers(); const release = Promise.withResolvers();
  const pending = create({}, { mode: "REPLAN", expectedBlock: { id: first.id, revision: 1 } }, {
    async createBlock(context) { entered.resolve(); await release.promise; return deterministicBlockPlanner.createBlock(context); },
  });
  await entered.promise;
  await createRaceGoal(user.id, race());
  release.resolve();
  await assert.rejects(pending, StaleBlockGenerationError);
  assert.equal((await getActiveDevelopmentBlock(user.id)).id, first.id);
  assert.equal((await getActiveDevelopmentBlock(user.id)).revision, 1);
});
