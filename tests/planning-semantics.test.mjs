import assert from "node:assert/strict";
import { test, after } from "node:test";
import {
  addCalendarDays, calendarMonday, easyWorkout, runPlanGeneration, generatePlanWithCorrections, deterministicPlanProvider, finalizePlanProposal,
  ProposalValidationError, ProposalAttemptsExhaustedError, PlanningContextSchema, emptyAthleteProfile,
} from "@pkg/shared";
import {
  prisma, saveWeeklyGoals, saveAthleteProfile, buildPlanningContext, createOrReusePlanRun, executePlanRun,
  generateAndSaveFlexiblePlan, updateWorkoutFeedback, createRaceGoal,
  generationInputIsCurrent,
} from "@pkg/db";
import { planningScenarios, hardWorkout } from "./fixtures/planning-scenarios.mjs";

assert.match(process.env.OAUTH_TEST_DATABASE ?? "", /^planner_oauth_test_[a-f0-9]{16}$/);
assert.equal(new URL(process.env.DATABASE_URL).pathname, `/${process.env.OAUTH_TEST_DATABASE}`);
after(async () => prisma.$disconnect());
const inputFor = id => planningScenarios().find(scenario => scenario.id === id).input;
const proposal = workouts => ({ version: 1, explanation: "Synthetic coherent workout proposal", workouts });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function userWithGoals() {
  const user = await prisma.user.create({ data: {} });
  await saveWeeklyGoals(user.id, { RUN: 120, BIKE: 240, SWIM: 0 });
  return user;
}

test("235 and 250 minutes both satisfy a 240-minute target without changing it", () => {
  const input = inputFor("coherent-duration");
  for (const minutes of [235, 250]) {
    const plan = finalizePlanProposal(input, proposal([easyWorkout("coherent", "2026-09-08", "BIKE", minutes)]));
    assert.equal(plan.goals.BIKE, 240);
    assert.equal(plan.totalMinutes, minutes);
    assert.equal(plan.analysis.deviations.find(value => value.type === "GOAL_DIFFERENCE" && value.sport === "BIKE").measurements.differenceMinutes, minutes - 240);
  }
});

test("same-day, adjacent-day, and dense hard sessions are accepted and measured", () => {
  const input = inputFor("normal-build");
  const plan = finalizePlanProposal(input, proposal([
    hardWorkout("one", "2026-09-08"), hardWorkout("two", "2026-09-08", "RUN"),
    hardWorkout("three", "2026-09-09"), hardWorkout("four", "2026-09-10"),
  ]));
  assert.deepEqual(plan.analysis.hardSessions, { total: 4, bySport: { BIKE: 3, RUN: 1, SWIM: 0 }, sameDayPairs: 1, consecutiveDayPairs: 3, recoveryHours: null });
  assert.ok(plan.analysis.deviations.some(value => value.type === "SAME_DAY_HARD_SESSIONS"));
  assert.ok(plan.analysis.deviations.some(value => value.type === "HARD_SESSION_CLUSTER"));
});

test("seven available training days are a deviation, while an explicit rest date is binding", () => {
  const input = inputFor("normal-build");
  const workouts = input.context.availability.days.map(day => easyWorkout(day.date, day.date, "RUN", 20));
  assert.ok(finalizePlanProposal(input, proposal(workouts)).analysis.deviations.some(value => value.type === "NO_REST_DAY"));
  input.context.availability.days[0].settings = { availableMinutes: 0, maxSessions: 0, allowedSports: [], poolAccess: false };
  assert.throws(() => finalizePlanProposal(input, proposal(workouts)), ProposalValidationError);
});

test("progression distinguishes illness return from newly established lower volume", () => {
  const workouts = [easyWorkout("run", "2026-09-08", "RUN", 180)];
  const deviation = id => finalizePlanProposal(inputFor(id), proposal(workouts)).analysis.deviations.find(value => value.type === "VOLUME_INCREASE" && value.sport === "RUN");
  const returning = deviation("illness-return");
  const growing = deviation("sparse-history");
  assert.equal(returning.measurements.changeFromPreviousPercent, 63.6);
  assert.equal(growing.measurements.changeFromPreviousPercent, 63.6);
  assert.equal(returning.measurements.recentEstablishedMinutes, 185);
  assert.equal(growing.measurements.recentEstablishedMinutes, 90);
  assert.ok(returning.measurements.changeFromEstablishedPercent < 0);
  assert.equal(growing.measurements.changeFromEstablishedPercent, 100);
});

test("zero history gives null percentages and intensity remains unknown without observations", () => {
  const input = inputFor("normal-build");
  for (const week of input.context.trainingHistory.weeks) week.sports.RUN = { minutes: 0, sessions: 0, longestMinutes: 0, completedPlanSessions: 0, completedPlanHardSessions: 0 };
  const plan = finalizePlanProposal(input, proposal([hardWorkout("new", "2026-09-08", "RUN")]));
  const measurements = plan.analysis.deviations.find(value => value.type === "VOLUME_INCREASE" && value.sport === "RUN").measurements;
  assert.equal(measurements.changeFromPreviousPercent, null);
  assert.equal(measurements.recentEstablishedMinutes, null);
  assert.ok(!plan.analysis.deviations.some(value => value.type === "INTENSITY_INCREASE"));
  input.context.trainingHistory.weeks[0].sports.RUN.completedPlanSessions = 2;
  assert.ok(finalizePlanProposal(input, proposal([hardWorkout("new", "2026-09-08", "RUN")])).analysis.deviations.some(value => value.type === "INTENSITY_INCREASE"));
});

test("volume, frequency and longest-session decreases/increases are evidence without rejection", () => {
  const input = inputFor("normal-build");
  const low = finalizePlanProposal(input, proposal([easyWorkout("small", "2026-09-08", "BIKE", 15)]));
  assert.ok(low.analysis.deviations.some(value => value.type === "VOLUME_DECREASE" && value.sport === "BIKE"));
  const high = finalizePlanProposal(input, proposal([easyWorkout("long", "2026-09-08", "RUN", 130), easyWorkout("short", "2026-09-09", "RUN", 20), easyWorkout("third", "2026-09-10", "RUN", 20)]));
  for (const type of ["VOLUME_INCREASE", "SESSION_FREQUENCY_INCREASE", "LONG_SESSION_INCREASE"]) assert.ok(high.analysis.deviations.some(value => value.type === type && value.sport === "RUN"));
});

test("user limits, excluded sports, malformed structure, dates and missing baselines remain hard failures", () => {
  const cases = [
    ["normal-build", input => { input.context.availability.days[1].settings.maxSessions = 1; }, () => [easyWorkout("a", "2026-09-08", "RUN", 30), easyWorkout("b", "2026-09-08", "BIKE", 30)], "DAILY_LIMIT"],
    ["normal-build", input => { input.context.availability.days[1].settings.availableMinutes = 20; }, () => [easyWorkout("a", "2026-09-08", "RUN", 30)], "AVAILABILITY_OR_RESTRICTION"],
    ["no-pool", () => {}, () => [easyWorkout("swim", "2026-09-08", "SWIM", 30)], "AVAILABILITY_OR_RESTRICTION"],
    ["run-restriction", () => {}, () => [easyWorkout("run", "2026-09-08", "RUN", 30)], "AVAILABILITY_OR_RESTRICTION"],
    ["coherent-duration", () => {}, () => [easyWorkout("run", "2026-09-08", "RUN", 30)], "EXCLUDED_SPORT"],
    ["normal-build", () => {}, () => [easyWorkout("date", "2026-09-21", "RUN", 30)], "DATE_RANGE"],
    ["normal-build", () => {}, () => [{ ...easyWorkout("duration", "2026-09-08", "RUN", 30), durationMinutes: 31 }], "SCHEMA"],
    ["no-ftp", () => {}, () => { const workout = easyWorkout("ftp", "2026-09-08", "BIKE", 30); workout.blocks[0].segments[1].target = { metric: "FTP_PERCENT", lower: 60, upper: 70 }; return [workout]; }, "UNRESOLVABLE_TARGET"],
  ];
  for (const [id, change, workouts, code] of cases) {
    const input = inputFor(id); change(input);
    assert.throws(() => finalizePlanProposal(input, proposal(workouts())), error => error instanceof ProposalValidationError && error.issues.some(issue => issue.code === code && Array.isArray(issue.path)));
  }
});

test("provider labels and mutated inputs cannot redefine server targets or constraints", () => {
  const input = inputFor("normal-build");
  const workout = hardWorkout("hard", "2026-09-08"); workout.effort = "EASY";
  assert.equal(finalizePlanProposal(input, proposal([workout])).analysis.hardSessions.total, 1);
  assert.throws(() => runPlanGeneration(input.context, input.fromDate, [], copy => {
    copy.context.availability.days[1].settings.poolAccess = true;
    return { ...proposal([]), goals: { RUN: 0, BIKE: 999, SWIM: 0 } };
  }), ProposalValidationError);
});

test("correction attempts receive structured errors and the same unmodified snapshot", async () => {
  const input = inputFor("normal-build"); let calls = 0;
  const plan = await generatePlanWithCorrections(input, async (copy, correction) => {
    calls++;
    assert.deepEqual(copy, input);
    if (calls === 1) { copy.context.goals.RUN = 999; return proposal([{ invalid: true }]); }
    assert.equal(correction.attempt, 2);
    assert.ok(correction.previousErrors.some(issue => issue.code === "SCHEMA"));
    return deterministicPlanProvider(copy);
  });
  assert.equal(calls, 2); assert.equal(plan.goals.RUN, 120);
});

test("proposal retries stop at three; infrastructure exceptions do not consume correction attempts", async () => {
  const input = inputFor("normal-build"); let calls = 0;
  await assert.rejects(generatePlanWithCorrections(input, async () => { calls++; return {}; }), error => error instanceof ProposalAttemptsExhaustedError && error.attempts === 3);
  assert.equal(calls, 3); calls = 0;
  await assert.rejects(generatePlanWithCorrections(input, async () => { calls++; throw new Error("Network unavailable"); }), /Network unavailable/);
  assert.equal(calls, 1);
});

test("all 20 evaluation inputs validate and deterministic generation remains available", async () => {
  const scenarios = planningScenarios(); assert.equal(scenarios.length, 20);
  for (const scenario of scenarios) {
    PlanningContextSchema.parse(scenario.input.context);
    const plan = await generatePlanWithCorrections(scenario.input);
    assert.deepEqual(plan.goals, scenario.input.context.goals, scenario.id);
    for (const workout of scenario.input.protectedWorkouts) assert.deepEqual(plan.days.find(day => day.id === workout.id), workout);
  }
});

test("context includes older local activity volume without changing recent budgets", async () => {
  const user = await userWithGoals();
  await prisma.activity.createMany({ data: [
    { userId: user.id, type: "RUN", startedAt: new Date("2026-07-07T10:00:00Z"), durationSeconds: 190 * 60 },
    { userId: user.id, type: "RUN", startedAt: new Date("2026-08-25T10:00:00Z"), durationSeconds: 110 * 60 },
  ] });
  const context = await buildPlanningContext(user.id, { now: new Date("2026-09-06T12:00:00Z") });
  assert.equal(context.trainingHistory.weeks.length, 12);
  assert.equal(context.trainingHistory.weeks.find(week => week.weekStart === "2026-07-06").sports.RUN.minutes, 190);
  assert.equal(context.recentTraining.weeks.filter(week => !week.isCurrentWeek).reduce((sum, week) => sum + week.run.durationMinutes, 0), 110);
});

test("a paused generator holds no transaction lock; settings edits invalidate its result", async () => {
  for (const edit of [
    user => saveWeeklyGoals(user.id, { RUN: 180, BIKE: 240, SWIM: 0 }),
    user => { const profile = emptyAthleteProfile(); profile.availability.overrides = [{ date: addCalendarDays(calendarMonday(new Date().toISOString().slice(0, 10)), 8), settings: { availableMinutes: 0, maxSessions: 0, allowedSports: [], poolAccess: false }, note: null }]; return saveAthleteProfile(user.id, profile, "UTC"); },
    user => { const profile = emptyAthleteProfile(); profile.restrictions = [{ id: "pause", sport: "RUN", kind: "NO_TRAINING", maxSessionMinutes: null, startDate: "2026-09-01", endDate: null, description: "Pause running" }]; return saveAthleteProfile(user.id, profile, "UTC"); },
    user => saveAthleteProfile(user.id, emptyAthleteProfile(), "America/Chicago"),
  ]) {
    const user = await userWithGoals();
    const before = await generateAndSaveFlexiblePlan(user.id);
    const run = await createOrReusePlanRun(user.id, { scope: "NEXT_WEEK" });
    const entered = deferred(), release = deferred();
    const running = executePlanRun(run.id, async input => { entered.resolve(); await release.promise; return deterministicPlanProvider(input); });
    try { await entered.promise; await edit(user); } finally { release.resolve(); }
    assert.equal((await running).status, "CANCELLED");
    assert.deepEqual((await prisma.weeklyPlan.findUniqueOrThrow({ where: { id: before.id } })).content, before.content);
  }
});

test("new generation B supersedes A after an edit and A cannot overwrite B", async () => {
  const user = await userWithGoals();
  const first = await createOrReusePlanRun(user.id, { scope: "NEXT_WEEK" });
  const entered = deferred(), release = deferred();
  const running = executePlanRun(first.id, async input => { entered.resolve(); await release.promise; return deterministicPlanProvider(input); });
  let latest;
  try {
    await entered.promise;
    await saveWeeklyGoals(user.id, { RUN: 180, BIKE: 300, SWIM: 0 });
    const second = await createOrReusePlanRun(user.id, { scope: "NEXT_WEEK" });
    assert.notEqual(second.id, first.id);
    assert.equal((await executePlanRun(second.id)).status, "SUCCESS");
    latest = await prisma.weeklyPlan.findFirstOrThrow({ where: { userId: user.id } });
  } finally { release.resolve(); }
  assert.equal((await running).status, "CANCELLED");
  assert.deepEqual(await prisma.weeklyPlan.findUniqueOrThrow({ where: { id: latest.id } }), latest);
});

test("feedback and new race inputs invalidate an in-flight proposal", async () => {
  for (const kind of ["feedback", "race"]) {
    const user = await userWithGoals(); const saved = await generateAndSaveFlexiblePlan(user.id);
    const run = await createOrReusePlanRun(user.id, { scope: "NEXT_WEEK" });
    const entered = deferred(), release = deferred();
    const running = executePlanRun(run.id, async input => { entered.resolve(); await release.promise; return deterministicPlanProvider(input); });
    try {
      await entered.promise;
      if (kind === "feedback") {
        const workout = saved.content.days.find(day => day.kind === "WORKOUT");
        await updateWorkoutFeedback(user.id, { planId: saved.id, workoutId: workout.id, expectedUpdatedAt: saved.updatedAt, locked: true, completion: "PLANNED", comment: "Keep this", rpe: null });
      } else await createRaceGoal(user.id, { ...inputFor("normal-build").context.races[0].goal, date: addCalendarDays(new Date().toISOString().slice(0, 10), 30) });
    } finally { release.resolve(); }
    assert.equal((await running).status, "CANCELLED");
  }
});

test("proposal exhaustion is terminal and preserves the plan without BullMQ multiplying correction attempts", async () => {
  const user = await userWithGoals(); const before = await generateAndSaveFlexiblePlan(user.id);
  const run = await createOrReusePlanRun(user.id, { scope: "NEXT_WEEK" }); let calls = 0;
  assert.equal((await executePlanRun(run.id, async () => { calls++; return {}; })).status, "FAILED");
  assert.equal(calls, 3);
  assert.equal((await executePlanRun(run.id, async () => { calls++; return {}; })).status, "FAILED");
  assert.equal(calls, 3);
  const persisted = await prisma.jobRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(persisted.attemptsStarted, 1); assert.equal(persisted.nextRetryAt, null);
  assert.deepEqual((await prisma.weeklyPlan.findUniqueOrThrow({ where: { id: before.id } })).content, before.content);
});

test("infrastructure retries retain the frozen snapshot and duplicate delivery never regenerates success", async () => {
  const user = await userWithGoals(); const run = await createOrReusePlanRun(user.id, { scope: "NEXT_WEEK" });
  let originalInput;
  await assert.rejects(executePlanRun(run.id, async input => { originalInput = input; throw new Error("Transient provider failure"); }), /retrying/);
  await prisma.jobRun.update({ where: { id: run.id }, data: { nextRetryAt: null } });
  assert.equal((await executePlanRun(run.id, async input => { assert.deepEqual(input, originalInput); return deterministicPlanProvider(input); })).status, "SUCCESS");
  const saved = await prisma.weeklyPlan.findFirstOrThrow({ where: { userId: user.id } });
  assert.equal((await executePlanRun(run.id, async () => { throw new Error("Must not run"); })).status, "SUCCESS");
  assert.deepEqual(await prisma.weeklyPlan.findUniqueOrThrow({ where: { id: saved.id } }), saved);
});

test("expired attempt A cannot overwrite a recovered attempt B", async () => {
  const user = await userWithGoals(); const run = await createOrReusePlanRun(user.id, { scope: "NEXT_WEEK" });
  const entered = deferred(), release = deferred();
  const running = executePlanRun(run.id, async input => { entered.resolve(); await release.promise; return deterministicPlanProvider(input); });
  let saved;
  try {
    await entered.promise;
    assert.equal((await executePlanRun(run.id)).status, "DEFERRED");
    await prisma.jobRun.update({ where: { id: run.id }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await executePlanRun(run.id)).status, "SUCCESS");
    saved = await prisma.weeklyPlan.findFirstOrThrow({ where: { userId: user.id } });
  } finally { release.resolve(); }
  await running;
  assert.deepEqual(await prisma.weeklyPlan.findUniqueOrThrow({ where: { id: saved.id } }), saved);
});

test("a failed success-state write rolls back the generated plan in the same transaction", async () => {
  const user = await userWithGoals(); const before = await generateAndSaveFlexiblePlan(user.id);
  await saveWeeklyGoals(user.id, { RUN: 180, BIKE: 300, SWIM: 0 });
  const run = await createOrReusePlanRun(user.id, { scope: "NEXT_WEEK" });
  assert.ok(Number.isSafeInteger(run.id));
  // The file-level guard requires a disposable DB. Fault injection affects only this run.
  await prisma.$executeRawUnsafe(`CREATE FUNCTION reject_test_plan_success() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = ${run.id} AND NEW.status = 'SUCCESS' THEN RAISE EXCEPTION 'Injected success write failure'; END IF; RETURN NEW; END $$`);
  try {
    await prisma.$executeRawUnsafe('CREATE TRIGGER reject_test_plan_success BEFORE UPDATE ON "JobRun" FOR EACH ROW EXECUTE FUNCTION reject_test_plan_success()');
    await assert.rejects(executePlanRun(run.id), /retrying/);
    const after = await prisma.weeklyPlan.findUniqueOrThrow({ where: { id: before.id } });
    assert.deepEqual(after.content, before.content);
    assert.equal(after.updatedAt.toISOString(), before.updatedAt);
    assert.equal((await prisma.jobRun.findUniqueOrThrow({ where: { id: run.id } })).status, "PENDING");
  } finally {
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS reject_test_plan_success ON "JobRun"');
    await prisma.$executeRawUnsafe('DROP FUNCTION reject_test_plan_success()');
  }
});

test("snapshot ownership and local-day rollover prevent using a stale request", async () => {
  const user = await userWithGoals(); const other = await userWithGoals();
  const run = await createOrReusePlanRun(user.id, { scope: "NEXT_WEEK" });
  await assert.rejects(executePlanRun(run.id, async () => { throw new Error("Transport failed"); }), /retrying/);
  const row = await prisma.jobRun.findUniqueOrThrow({ where: { id: run.id } });
  const snapshot = row.planRequest.snapshot;
  const tomorrow = new Date(Date.parse(snapshot.context.generatedAt) + 86400000);
  assert.equal(await prisma.$transaction(database => generationInputIsCurrent(snapshot, database, tomorrow)), false);
  snapshot.context.athlete.id = other.id;
  await prisma.jobRun.update({ where: { id: run.id }, data: { planRequest: row.planRequest, nextRetryAt: null } });
  assert.equal((await executePlanRun(run.id, async () => { throw new Error("Must not execute"); })).status, "CANCELLED");
  assert.equal(await prisma.weeklyPlan.count({ where: { userId: { in: [user.id, other.id] } } }), 0);
});
