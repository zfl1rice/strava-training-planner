import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { FlexiblePlanSchema, calendarWorkouts, generateWeeklyPlan, summarizeTraining, validateStoredPlan, emptyAthleteProfile, generateFlexiblePlan, resolveWorkoutTargets } from "@pkg/shared";
import { prisma, getTrainingCalendar, buildPlanningContext, saveAthleteProfile, saveWeeklyGoals, generateAndSaveFlexiblePlan, getPlanningSettings, updatePlanningSettings, updateWorkoutFeedback } from "@pkg/db";

assert.match(process.env.OAUTH_TEST_DATABASE ?? "", /^planner_oauth_test_[a-f0-9]{16}$/);
assert.equal(new URL(process.env.DATABASE_URL).pathname, `/${process.env.OAUTH_TEST_DATABASE}`);
let user;
const now = new Date("2026-09-06T12:00:00Z");
beforeEach(async () => { user = await prisma.user.create({ data: {} }); });
after(async () => { await prisma.$disconnect(); });

function customPlan() {
  const old = generateWeeklyPlan(summarizeTraining([], now));
  const workout = (id, date) => ({ kind: "WORKOUT", id, date, templateId: null, sport: "BIKE", title: "Short intervals",
    effort: "HARD", optional: false, explanation: "Custom two-minute efforts", durationMinutes: 12,
    blocks: [{ repeat: 3, segments: [
      { label: "Work", seconds: 120, instructions: "Ride steadily", target: { metric: "FTP_PERCENT", lower: 100, upper: 110 } },
      { label: "Recover", seconds: 120, instructions: "Pedal gently", target: { metric: "RPE", lower: 2, upper: 3 } },
    ] }],
  });
  return { ...old, version: 2, days: old.days.map(day => ({ kind: "REST", date: day.date, title: "Rest day", durationMinutes: 0 }))
    .flatMap((day, index) => index === 1 ? [workout("a", day.date), workout("b", day.date)] : [day]),
    totalMinutes: 24, budgets: { ...old.budgets, RUN: { ...old.budgets.RUN, plannedMinutes: 0 },
      SWIM: { ...old.budgets.SWIM, plannedMinutes: 0 }, BIKE: { ...old.budgets.BIKE, plannedMinutes: 24, targetMinutes: 30 } } };
}

test("custom repeat blocks and multiple workouts survive storage, calendar, and context reads", async () => {
  const plan = FlexiblePlanSchema.parse(customPlan());
  await prisma.weeklyPlan.create({ data: { userId: user.id, weekStart: new Date(plan.weekStart), content: plan } });
  const calendar = await getTrainingCalendar(user.id, "2026-09");
  assert.deepEqual(calendar.plans[0].content, plan);
  assert.equal(calendarWorkouts(plan).length, 2);
  assert.equal(calendarWorkouts(plan)[0].steps.length, 6);
  assert.equal((await buildPlanningContext(user.id, { now })).existingPlans[0].content.version, 2);
});

test("structured plans reject invalid durations, duplicate IDs, wrong dates and target sports", () => {
  for (const mutate of [
    p => { p.days[1].durationMinutes = 99; }, p => { p.days[2].id = "a"; },
    p => { p.days[1].date = "2026-09-30"; }, p => { p.days[1].sport = "RUN"; },
    p => { p.days[1].blocks[0].repeat = 10000; },
  ]) { const plan = customPlan(); mutate(plan); assert.equal(FlexiblePlanSchema.safeParse(plan).success, false); }
  const legacy = generateWeeklyPlan(summarizeTraining([], now));
  assert.deepEqual(validateStoredPlan(legacy), legacy);
});

async function configuredContext() {
  const profile = emptyAthleteProfile();
  profile.availability.recurring = Array.from({ length: 6 }, (_, i) => ({ weekday: i + 1,
    settings: { availableMinutes: 240, maxSessions: 2, allowedSports: ["RUN", "BIKE", "SWIM"], poolAccess: i === 1 || i === 3 } }));
  await saveAthleteProfile(user.id, profile, "America/Chicago");
  await saveWeeklyGoals(user.id, { RUN: 200, BIKE: 500, SWIM: 150 });
  return buildPlanningContext(user.id, { now });
}

test("availability scheduling exceeds old caps and preserves goals, pool access and session limits", async () => {
  const context = await configuredContext();
  const saved = await generateAndSaveFlexiblePlan(user.id, now);
  assert.equal(saved.content.version, 2);
  assert.equal(saved.content.timeZone, "America/Chicago");
  assert.equal(saved.content.totalMinutes, 850);
  assert.equal(saved.content.budgets.BIKE.plannedMinutes, 500);
  for (const day of context.availability.days) {
    const sessions = saved.content.days.filter(w => w.kind === "WORKOUT" && w.date === day.date);
    assert.ok(sessions.length <= (day.settings?.maxSessions ?? 0));
    assert.ok(sessions.reduce((sum, w) => sum + w.durationMinutes, 0) <= (day.settings?.availableMinutes ?? 0));
    if (!day.settings?.poolAccess) assert.ok(sessions.every(w => w.sport !== "SWIM"));
  }
});

test("unconfigured days, overrides and restrictions produce explicit goal shortfalls", async () => {
  const context = await configuredContext();
  for (const day of context.availability.days) { day.settings = null; day.source = "UNCONFIGURED"; }
  assert.equal(generateFlexiblePlan(context).totalMinutes, 0);
  context.availability.days[1].settings = { availableMinutes: 200, maxSessions: 1, allowedSports: ["BIKE"], poolAccess: false };
  context.restrictions = [{ id: "limit", sport: "BIKE", kind: "MAX_SESSION_MINUTES", maxSessionMinutes: 40,
    startDate: "2026-09-01", endDate: null, description: "Temporary limit" }];
  const plan = generateFlexiblePlan(context);
  assert.equal(plan.totalMinutes, 40);
  assert.equal(plan.goals.BIKE, 500);
  assert.ok(plan.assumptions.some(note => note.includes("460 target minutes")));
});

test("calendar uses athlete-local dates around UTC midnight", async () => {
  await configuredContext();
  await prisma.activity.create({ data: { userId: user.id, type: "RUN", startedAt: new Date("2026-10-05T02:00:00Z"), durationSeconds: 600 } });
  const calendar = await getTrainingCalendar(user.id, "2026-09");
  assert.equal(calendar.timeZone, "America/Chicago");
  assert.equal(calendar.activities.length, 1);
});

test("targets resolve from baselines, declare missing data, and keep old snapshots stable", async () => {
  const context = await configuredContext();
  const workout = customPlan().days[1];
  assert.equal(resolveWorkoutTargets(workout, context.fitness, context.generatedAt).blocks[0].segments[0].resolved, null);
  context.fitness.effective.cycling.value = 250;
  const resolved = resolveWorkoutTargets(workout, context.fitness, context.generatedAt);
  assert.equal(resolved.blocks[0].segments[0].resolved.lower, 250);
  assert.equal(resolved.blocks[0].segments[0].resolved.upper, 275);
  context.fitness.effective.cycling.value = 300;
  assert.equal(resolved.blocks[0].segments[0].resolved.baseline, 250);
  assert.equal(resolveWorkoutTargets(workout, context.fitness, context.generatedAt).blocks[0].segments[0].resolved.upper, 330);
  context.fitness.definitions.running.thresholdPace = { value: 300, recordedAt: context.generatedAt, evidenceIds: [], explanation: null };
  workout.sport = "RUN";
  workout.blocks[0].segments[0].target = { metric: "THRESHOLD_PACE_PERCENT", lower: 110, upper: 120 };
  assert.equal(resolveWorkoutTargets(workout, context.fitness, context.generatedAt).blocks[0].segments[0].resolved.lower, 330);
});

test("feedback is owned, stale-safe, and visible in context without changing workout targets", async () => {
  await configuredContext();
  const saved = await generateAndSaveFlexiblePlan(user.id, now);
  const workout = calendarWorkouts(saved.content)[0];
  const change = { planId: saved.id, expectedUpdatedAt: saved.updatedAt, workoutId: workout.id, comment: "Too hard mentally", rpe: 9, completion: "STOPPED", locked: true };
  const other = await prisma.user.create({ data: {} });
  await assert.rejects(updateWorkoutFeedback(other.id, change), /not found/);
  await updateWorkoutFeedback(user.id, change);
  await assert.rejects(updateWorkoutFeedback(user.id, change), /changed/);
  const context = await buildPlanningContext(user.id, { now });
  assert.equal(context.existingPlans[0].workoutStates[0].feedback.rpe, 9);
  assert.deepEqual(context.existingPlans[0].content, saved.content);
});

test("dated adjustments reduce planned volume without rewriting goals and restrictions block a sport", async () => {
  await configuredContext();
  const settings = await getPlanningSettings(user.id);
  await updatePlanningSettings(user.id, { section: "ADJUSTMENTS", expectedUpdatedAt: settings.profileUpdatedAt,
    adjustments: [{ id: "recovery", sport: "BIKE", startDate: "2026-09-07", endDate: "2026-09-13", volumePercent: 50, intensityPercent: 50, comment: "Too much volume" }],
    restrictions: [{ id: "stop-run", sport: "RUN", startDate: "2026-09-07", endDate: "2026-09-13", kind: "NO_TRAINING", maxSessionMinutes: null, description: "User restriction" }],
  });
  const plan = (await generateAndSaveFlexiblePlan(user.id, now)).content;
  assert.equal(plan.goals.BIKE, 500);
  assert.equal(plan.budgets.BIKE.plannedMinutes, 250);
  assert.equal(plan.budgets.RUN.plannedMinutes, 0);
  assert.ok(calendarWorkouts(plan).filter(w => w.sport === "BIKE").every(w => w.blocks[0].segments[1].target.upper === 2));
});

test("remaining-week regeneration preserves past and locked workouts while applying new goals", async () => {
  await configuredContext();
  const first = await generateAndSaveFlexiblePlan(user.id, now);
  const workouts = calendarWorkouts(first.content);
  const locked = workouts.find(w => w.date === "2026-09-12");
  await updateWorkoutFeedback(user.id, { planId: first.id, workoutId: locked.id, expectedUpdatedAt: first.updatedAt,
    locked: true, completion: "PLANNED", rpe: null, comment: "Keep this one" });
  await saveWeeklyGoals(user.id, { RUN: 0, BIKE: 0, SWIM: 0 });
  const updated = await generateAndSaveFlexiblePlan(user.id, new Date("2026-09-10T15:00:00Z"), "REMAINING_WEEK");
  const retained = calendarWorkouts(updated.content);
  assert.equal(updated.id, first.id);
  assert.ok(retained.every(w => w.date < "2026-09-10" || w.id === locked.id));
  assert.deepEqual(retained.find(w => w.id === locked.id), locked);
  for (const old of workouts.filter(w => w.date < "2026-09-10")) assert.deepEqual(retained.find(w => w.id === old.id), old);
  assert.equal((await buildPlanningContext(user.id, { now: new Date("2026-09-10T15:00:00Z"), weekStart: "2026-09-07" })).existingPlans[0].workoutStates[0].feedback.comment, "Keep this one");
});

test("sync conflict leaves the saved plan intact", async () => {
  await configuredContext();
  const first = await generateAndSaveFlexiblePlan(user.id, now);
  await prisma.jobRun.create({ data: { userId: user.id, jobType: "STRAVA_SYNC", status: "PENDING" } });
  await assert.rejects(generateAndSaveFlexiblePlan(user.id, now), /sync/);
  assert.deepEqual((await prisma.weeklyPlan.findUnique({ where: { id: first.id } })).content, first.content);
});
