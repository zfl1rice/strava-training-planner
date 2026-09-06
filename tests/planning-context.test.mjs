import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { writeFile } from "node:fs/promises";
import {
  AthleteProfileSchema, LocalDateSchema, TimeZoneSchema, PlanningContextSchema,
  RaceGoalSchema, emptyAthleteProfile, localDateAt, calendarMonday,
} from "@pkg/shared";
import {
  prisma, buildPlanningContext, saveAthleteProfile, createRaceGoal, recordPerformanceEvidence,
  generateAndSaveWeeklyPlan, saveWorkoutStates, PlanHasProtectedWorkoutsError,
} from "@pkg/db";

assert.match(process.env.OAUTH_TEST_DATABASE ?? "", /^planner_oauth_test_[a-f0-9]{16}$/);
assert.equal(new URL(process.env.DATABASE_URL).pathname, `/${process.env.OAUTH_TEST_DATABASE}`);
const now = new Date("2026-09-06T12:00:00Z");
const stamp = "2026-09-01T12:00:00.000Z";
const baseline = value => ({ value, recordedAt: stamp, evidenceIds: [], explanation: null });
const available = (minutes, sports = ["RUN", "BIKE"]) => ({ availableMinutes: minutes, maxSessions: minutes ? 2 : 0, allowedSports: sports, poolAccess: sports.includes("SWIM") });
const race = (name, date, importance, sports = ["BIKE"]) => ({
  name, date, importance, sports, eventType: "CUSTOM", distanceMeters: null,
  expectedDurationSeconds: 120, performanceGoal: null, demandProfile: null,
});
const observation = (value, extra = {}) => ({ sport: "BIKE", metric: "POWER_DURATION", benchmark: 120,
  value, occurredAt: stamp, sourceActivityId: null, source: "MEASURED", isPersonalRecord: true, methodVersion: "test-v1", ...extra });
let user;
beforeEach(async () => {
  await prisma.activity.deleteMany();
  await prisma.jobRun.deleteMany();
  await prisma.user.deleteMany();
  user = await prisma.user.create({ data: {} });
});
after(async () => { await prisma.$disconnect(); });

test("manual FTP wins over an estimate; custom zones survive baseline edits; missing HR remains missing", async () => {
  const profile = emptyAthleteProfile();
  profile.fitness.cycling.baseline = { manual: baseline(250), estimate: baseline(270) };
  profile.fitness.cycling.zones = { mode: "CUSTOM", unit: "WATTS", boundaries: [
    { label: "Easy", lower: 0, upper: 180 }, { label: "Higher", lower: 180, upper: null },
  ] };
  await saveAthleteProfile(user.id, profile, "America/Chicago");
  let context = await buildPlanningContext(user.id, { now });
  assert.equal(context.fitness.effective.cycling.value, 250);
  assert.equal(context.fitness.effective.cycling.source, "MANUAL");
  assert.equal(context.fitness.effective.running.value, null);
  assert.equal(context.fitness.effective.running.source, "MISSING");
  profile.fitness.cycling.baseline.manual = baseline(260);
  await saveAthleteProfile(user.id, profile, "America/Chicago");
  context = await buildPlanningContext(user.id, { now });
  assert.deepEqual(context.fitness.definitions.cycling.zones, profile.fitness.cycling.zones);
  profile.fitness.cycling.baseline.manual = null;
  await saveAthleteProfile(user.id, profile, "America/Chicago");
  assert.equal((await buildPlanningContext(user.id, { now })).fitness.effective.cycling.source, "ESTIMATED");
});

test("multiple race scores are independent; stored custom demands are returned without generation", async () => {
  await createRaceGoal(user.id, race("70.3", "2027-01-10", 95, ["RUN", "BIKE", "SWIM"]));
  const sprint = race("Two-minute effort", "2026-10-10", 95);
  sprint.demandProfile = { version: 1, source: "USER", generatorVersion: "manual-v1", generatedAt: stamp,
    explanation: "A short cycling effort", weights: [
      { sport: "BIKE", capability: "TWO_TO_FIVE_MINUTE_POWER", weight: 100 },
      { sport: "BIKE", capability: "SHORT_ANAEROBIC", weight: 80 },
    ] };
  await createRaceGoal(user.id, sprint);
  await createRaceGoal(user.id, race("Past event", "2026-08-01", 100));
  const context = await buildPlanningContext(user.id, { now });
  assert.deepEqual(context.races.map(entry => entry.goal.importance), [95, 95]);
  assert.deepEqual(context.races[0].goal.demandProfile, sprint.demandProfile);
  assert.ok(context.performanceProfile.cycling.every(entry => entry.confidence === "INSUFFICIENT_EVIDENCE" && entry.score === null));
  assert.ok(context.performanceProfile.running.every(entry => entry.trend === "UNKNOWN"));
});

test("date overrides win, missing availability uses defaults, restrictions overlap the target week inclusively", async () => {
  const profile = emptyAthleteProfile();
  profile.availability.recurring = [{ weekday: 0, settings: available(60, ["SWIM"]) }];
  profile.availability.overrides = [{ date: "2026-09-07", settings: available(0, []), note: "Pool closed" }];
  const restriction = { id: "run-pause", sport: "RUN", kind: "NO_TRAINING", maxSessionMinutes: null,
    startDate: "2026-09-01", endDate: "2026-09-07", description: "No running" };
  profile.restrictions = [restriction,
    { ...restriction, id: "expired", endDate: "2026-09-06" },
    { ...restriction, id: "later", startDate: "2026-09-14", endDate: null },
  ];
  await saveAthleteProfile(user.id, profile, "America/Chicago");
  const context = await buildPlanningContext(user.id, { now });
  assert.equal(context.availability.days[0].source, "OVERRIDE");
  assert.equal(context.availability.days[0].settings.availableMinutes, 0);
  assert.equal(context.availability.days[1].source, "DEFAULT");
  assert.deepEqual(context.availability.days[1].settings, { availableMinutes: 1440, maxSessions: 3, allowedSports: ["RUN", "BIKE", "SWIM"], poolAccess: true });
  assert.deepEqual(context.restrictions, [restriction]);
  assert.equal(context.availability.recurring[0].settings.availableMinutes, 60);
});

test("local dates control week selection and activity aggregation across UTC midnight and DST", async () => {
  await saveAthleteProfile(user.id, emptyAthleteProfile(), "America/Chicago");
  const sundayNight = new Date("2026-09-07T02:00:00Z");
  await prisma.activity.createMany({ data: [
    { userId: user.id, type: "BIKE", startedAt: new Date("2026-08-31T02:00:00Z"), durationSeconds: 1800 }, // previous Sunday
    { userId: user.id, type: "RUN", startedAt: new Date("2026-09-07T01:00:00Z"), durationSeconds: 600 }, // current Sunday
    { userId: user.id, type: "RUN", startedAt: new Date("2026-09-07T03:00:00Z"), durationSeconds: 999 }, // future instant
  ] });
  const context = await buildPlanningContext(user.id, { now: sundayNight });
  assert.equal(context.targetWeek.startDate, "2026-09-07");
  assert.equal(context.recentTraining.weeks[0].weekStart, "2026-08-31");
  assert.equal(context.recentTraining.weeks[0].run.durationSeconds, 600);
  assert.equal(context.recentTraining.weeks[1].bike.durationSeconds, 1800);
  for (const instant of ["2026-03-08T07:59:00Z", "2026-03-08T08:01:00Z"]) {
    assert.equal(localDateAt(new Date(instant), "America/Chicago"), "2026-03-08");
  }
  for (const instant of ["2026-11-01T06:30:00Z", "2026-11-01T07:30:00Z"]) {
    assert.equal(localDateAt(new Date(instant), "America/Chicago"), "2026-11-01");
  }
  assert.equal(calendarMonday("2027-01-01"), "2026-12-28");
  const east = await prisma.user.create({ data: { timeZone: "Pacific/Kiritimati" } });
  assert.equal((await buildPlanningContext(east.id, { now })).targetWeek.startDate, "2026-09-14");
});

test("locked/completed workouts and feedback survive context reads and block destructive v1 regeneration", async () => {
  const plan = await generateAndSaveWeeklyPlan(user.id, now);
  const workouts = plan.content.days.filter(day => day.kind === "WORKOUT");
  const states = [
    { date: workouts[0].date, templateId: workouts[0].templateId, locked: true, completion: "PLANNED", feedback: null },
    { date: workouts[1].date, templateId: workouts[1].templateId, locked: false, completion: "MODIFIED", feedback: { rpe: 8, comment: "Stopped early" } },
  ];
  await saveWorkoutStates(user.id, plan.id, plan.updatedAt, states);
  const context = await buildPlanningContext(user.id, { now });
  assert.deepEqual(context.existingPlans[0].content, plan.content);
  assert.deepEqual(context.existingPlans[0].workoutStates, states);
  await assert.rejects(generateAndSaveWeeklyPlan(user.id, now), PlanHasProtectedWorkoutsError);
  await assert.rejects(saveWorkoutStates(user.id, plan.id, "2000-01-01T00:00:00.000Z", []), /Plan changed/);
  const updated = await prisma.weeklyPlan.findUniqueOrThrow({ where: { id: plan.id } });
  await assert.rejects(saveWorkoutStates(user.id, plan.id, updated.updatedAt.toISOString(), [{ ...states[0], date: "2026-09-14" }]));
});

test("ownership excludes other athletes and credentials; evidence cannot reference another user's activity", async () => {
  const other = await prisma.user.create({ data: { stravaConnection: { create: {
    athleteId: 98765n, accessToken: "private-access", refreshToken: "private-refresh", expiresAt: now, scopes: [],
  } } } });
  await createRaceGoal(other.id, race("Private race", "2026-10-10", 100));
  const activity = await prisma.activity.create({ data: { userId: other.id, type: "BIKE", durationSeconds: 100, startedAt: now } });
  await assert.rejects(recordPerformanceEvidence(user.id, observation(300, { sourceActivityId: activity.id })), /belong/);
  const evidenceId = await recordPerformanceEvidence(other.id, observation(300));
  const profile = emptyAthleteProfile();
  profile.fitness.cycling.baseline.estimate = { ...baseline(250), evidenceIds: [evidenceId] };
  await assert.rejects(saveAthleteProfile(user.id, profile, "UTC"), /another athlete/);
  const otherPlan = await generateAndSaveWeeklyPlan(other.id, now);
  await assert.rejects(saveWorkoutStates(user.id, otherPlan.id, otherPlan.updatedAt, []), /not found/);
  const context = await buildPlanningContext(user.id, { now });
  assert.deepEqual(context.races, []);
  assert.deepEqual(context.existingPlans, []);
  assert.deepEqual(context.performanceProfile.evidence, []);
  assert.doesNotMatch(JSON.stringify(context), /private-access|private-refresh|accessToken|refreshToken|tokenHash/);
  await assert.rejects(buildPlanningContext(2147483647, { now }), /not found/);
});

test("evidence history is retained, source deletion preserves observations, and PRs do not change FTP", async () => {
  const activity = await prisma.activity.create({ data: { userId: user.id, type: "BIKE", durationSeconds: 120, startedAt: now } });
  await recordPerformanceEvidence(user.id, observation(300, { sourceActivityId: activity.id }));
  await recordPerformanceEvidence(user.id, observation(310));
  await prisma.activity.delete({ where: { id: activity.id } });
  const context = await buildPlanningContext(user.id, { now });
  assert.equal(context.performanceProfile.historyRecordCount, 2);
  assert.deepEqual(context.performanceProfile.evidence.map(entry => entry.observation.value), [310, 300]);
  assert.equal(context.performanceProfile.evidence[1].observation.sourceActivityId, null);
  assert.equal(context.fitness.effective.cycling.source, "MISSING");
});

test("bounded context retains older cited evidence and declares omitted history", async () => {
  const firstId = await recordPerformanceEvidence(user.id, observation(250, { occurredAt: "2025-01-01T00:00:00.000Z" }));
  const profile = emptyAthleteProfile();
  profile.fitness.cycling.baseline.estimate = { ...baseline(230), evidenceIds: [firstId] };
  await saveAthleteProfile(user.id, profile, "UTC");
  await prisma.performanceEvidence.createMany({ data: Array.from({ length: 110 }, (_, index) => ({
    ...observation(300 + index), occurredAt: new Date(stamp), userId: user.id,
  })) });
  const context = await buildPlanningContext(user.id, { now });
  assert.equal(context.performanceProfile.historyRecordCount, 111);
  assert.equal(context.performanceProfile.evidence.length, 101);
  assert.equal(context.performanceProfile.evidenceTruncated, true);
  assert.ok(context.performanceProfile.evidence.some(entry => entry.id === firstId));
});

test("invalid dates, zones, capabilities, and race demands are rejected", () => {
  for (const date of ["2026-02-30", "2026-13-01", "2026-9-01"]) assert.equal(LocalDateSchema.safeParse(date).success, false);
  assert.equal(TimeZoneSchema.safeParse("Imaginary/Zone").success, false);
  const profile = emptyAthleteProfile();
  profile.fitness.running.zones = { mode: "CUSTOM", unit: "WATTS", boundaries: [{ label: "One", lower: 0, upper: 150 }] };
  assert.equal(AthleteProfileSchema.safeParse(profile).success, false);
  profile.fitness.running.zones = { mode: "CUSTOM", unit: "BPM", boundaries: [
    { label: "One", lower: 0, upper: 150 }, { label: "Two", lower: 140, upper: null },
  ] };
  assert.equal(AthleteProfileSchema.safeParse(profile).success, false);
  profile.fitness.running.zones = { mode: "DERIVED" };
  profile.capabilities = [{ sport: "BIKE", key: "SPRINT", score: 0, confidence: "INSUFFICIENT_EVIDENCE",
    trend: "DECLINING", evidenceIds: [], updatedAt: null, methodVersion: null }];
  assert.equal(AthleteProfileSchema.safeParse(profile).success, false);
  assert.equal(RaceGoalSchema.safeParse(race("Bad", "2026-10-10", 101)).success, false);
});

test("seeded athlete produces a readable validated context without calling Strava or AI", async () => {
  const profile = emptyAthleteProfile();
  profile.fitness.cycling.baseline.manual = baseline(250);
  profile.fitness.swimming.paceUnit = "SECONDS_PER_100YD";
  profile.fitness.swimming.baseline.manual = baseline(100);
  profile.availability.recurring = Array.from({ length: 7 }, (_, weekday) => ({ weekday, settings: available(weekday ? 60 : 0, ["RUN", "BIKE", "SWIM"]) }));
  await saveAthleteProfile(user.id, profile, "America/Chicago");
  await createRaceGoal(user.id, race("Example 70.3", "2027-01-10", 95, ["RUN", "BIKE", "SWIM"]));
  await recordPerformanceEvidence(user.id, observation(350));
  await generateAndSaveWeeklyPlan(user.id, now);
  const context = await buildPlanningContext(user.id, { now });
  assert.equal(PlanningContextSchema.safeParse(context).success, true);
  assert.equal(context.fitness.effective.swimming.unit, "SECONDS_PER_100YD");
  const repeated = await buildPlanningContext(user.id, { now });
  assert.deepEqual(repeated, context);
  if (process.env.WRITE_PLANNING_CONTEXT_EXAMPLE === "true") {
    await writeFile(new URL("../docs/planning-context.example.json", import.meta.url), `${JSON.stringify(context, null, 2)}\n`);
  }
});
