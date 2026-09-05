import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { NextRequest } from "next/server.js";
import pg from "pg";
import { AUTOMATIC_WEEKLY_GOALS, WeeklyGoalsSchema, generateWeeklyPlan, validateWeeklyPlan, summarizeTraining, mondayUtc, WORKOUT_TEMPLATES } from "@pkg/shared";
import { prisma, generateAndSaveWeeklyPlan, getPlannerState, getWeeklyGoals, saveWeeklyGoals, createOrReuseSyncRun, PlanSyncInProgressError } from "@pkg/db";
import { POST as generate, GET as readPlan, PATCH as configure } from "../apps/web/src/app/api/planner/route.ts";
import { hashToken, newOpaqueToken } from "../apps/web/src/lib/strava-auth.ts";

assert.match(process.env.OAUTH_TEST_DATABASE ?? "", /^planner_oauth_test_[a-f0-9]{16}$/);
assert.equal(new URL(process.env.DATABASE_URL).pathname, `/${process.env.OAUTH_TEST_DATABASE}`);
const now = new Date("2026-09-04T12:00:00Z");
const weekMs = 7 * 86400000;
const previousDate = (offset, time = now) => new Date(mondayUtc(time).getTime() - offset * weekMs + 12 * 3600000);
const activity = (type, minutes, startedAt) => ({ type, durationSeconds: minutes * 60, startedAt, distanceMeters: null });
const history = (budgets, time = now) => [1, 2, 3].flatMap(offset => Object.entries(budgets).map(([sport, minutes]) => activity(sport, minutes, previousDate(offset, time))));
const workouts = plan => plan.days.filter(day => day.kind === "WORKOUT");
const forSport = (plan, sport) => workouts(plan).filter(day => day.sport === sport);
let user;
let session;

beforeEach(async () => {
  await prisma.activity.deleteMany();
  await prisma.jobRun.deleteMany();
  await prisma.user.deleteMany();
  session = newOpaqueToken();
  user = await prisma.user.create({ data: { name: "Planner Test", sessions: { create: {
    tokenHash: hashToken(session), expiresAt: new Date(Date.now() + 600000),
  } } } });
});
after(async () => { await prisma.$disconnect(); });

function request(method = "POST", token = session, origin = "http://localhost:3000", body) {
  return new NextRequest("http://localhost:3000/api/planner", { method, headers: {
    origin, cookie: `planner_session=${token}`,
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
}

test("identical history generates identical plans without mutating its input", () => {
  const summary = summarizeTraining(history({ RUN: 90, BIKE: 120, SWIM: 40 }), now);
  const original = structuredClone(summary);
  assert.deepEqual(generateWeeklyPlan(summary), generateWeeklyPlan(summary));
  assert.deepEqual(summary, original);
});

test("completed-week sport averages set budgets; current-week and other volume do not inflate them", () => {
  const summary = summarizeTraining([
    ...history({ RUN: 90, BIKE: 120, SWIM: 40, OTHER: 1000 }),
    activity("RUN", 1000, now),
  ], now);
  const plan = generateWeeklyPlan(summary);
  assert.equal(plan.mode, "HISTORY");
  assert.equal(plan.budgets.RUN.averageMinutes, 90);
  assert.equal(plan.budgets.BIKE.targetMinutes, 120);
  assert.deepEqual(forSport(plan, "BIKE").map(day => day.durationMinutes), [45, 75]);
  assert.equal(plan.totalMinutes, 250);
  assert.equal(workouts(plan).length, 6);
  assert.equal(plan.days[0].kind, "REST");
  assert.ok(workouts(plan).every(day => day.effort === "EASY"));
});

test("small budgets produce fewer sessions instead of forcing six workouts", () => {
  const plan = generateWeeklyPlan(summarizeTraining(history({ RUN: 10, BIKE: 20, SWIM: 10 }), now));
  assert.equal(workouts(plan).length, 3);
  assert.equal(plan.totalMinutes, 40);
  assert.equal(plan.days.filter(day => day.kind === "REST").length, 4);
});

test("template caps leave surplus minutes unused", () => {
  const plan = generateWeeklyPlan(summarizeTraining(history({ RUN: 500, BIKE: 500, SWIM: 500 }), now));
  assert.equal(plan.budgets.RUN.plannedMinutes, 105);
  assert.equal(plan.budgets.BIKE.plannedMinutes, 180);
  assert.equal(plan.budgets.SWIM.plannedMinutes, 75);
  assert.ok(plan.assumptions.some(text => text.includes("left unused")));
});

test("sparse history is divided across all three weeks without adding missing sports", () => {
  const plan = generateWeeklyPlan(summarizeTraining([activity("RUN", 60, previousDate(1))], now));
  assert.equal(plan.budgets.RUN.averageMinutes, 20);
  assert.equal(plan.budgets.RUN.activeWeeks, 1);
  assert.equal(plan.totalMinutes, 20);
  assert.ok(workouts(plan).every(day => day.sport === "RUN"));
  assert.ok(plan.assumptions.some(text => text.includes("1 of three")));
});

test("no usable history produces a clearly labeled optional starter schedule", () => {
  const plan = generateWeeklyPlan(summarizeTraining([], now));
  assert.equal(plan.mode, "STARTER");
  assert.equal(plan.totalMinutes, 40);
  assert.equal(workouts(plan).length, 3);
  assert.ok(workouts(plan).every(day => day.optional));
  assert.ok(plan.assumptions.some(text => text.includes("not an estimate of your fitness")));
});

test("other-only history and unfinished-week workouts cannot establish triathlon budgets", () => {
  const plan = generateWeeklyPlan(summarizeTraining([...history({ OTHER: 500 }), activity("BIKE", 500, now)], now));
  assert.equal(plan.mode, "STARTER");
  assert.equal(plan.budgets.BIKE.averageMinutes, 0);
});

test("recorded budgets below template minima produce rest instead of increasing volume", () => {
  const plan = generateWeeklyPlan(summarizeTraining(history({ RUN: 5, BIKE: 5, SWIM: 5 }), now));
  assert.equal(plan.mode, "HISTORY");
  assert.equal(plan.totalMinutes, 0);
  assert.ok(plan.days.every(day => day.kind === "REST"));
});

test("schedules cover the following full UTC week across year boundaries", () => {
  const time = new Date("2026-12-31T23:59:59Z");
  const plan = generateWeeklyPlan(summarizeTraining(history({ RUN: 60 }, time), time));
  assert.equal(plan.weekStart, "2027-01-04T00:00:00.000Z");
  assert.equal(plan.weekEnd, "2027-01-11T00:00:00.000Z");
  assert.deepEqual(plan.days.map(day => day.date), ["2027-01-04", "2027-01-05", "2027-01-06", "2027-01-07", "2027-01-08", "2027-01-09", "2027-01-10"]);
});

test("boundary budgets preserve session limits, time accounting, and at most one workout each day", () => {
  for (const sport of ["RUN", "BIKE", "SWIM"]) {
    for (const volume of [0, 1, 9, 10, 15, 20, 25, 35, 60, 120, 500]) {
      const plan = generateWeeklyPlan(summarizeTraining(history({ RUN: 60, BIKE: 120, SWIM: 40, [sport]: volume }), now));
      assert.equal(new Set(plan.days.map(day => day.date)).size, 7);
      assert.ok(plan.budgets[sport].plannedMinutes <= volume);
      for (const day of workouts(plan)) {
        const definition = WORKOUT_TEMPLATES.find(template => template.id === day.templateId);
        assert.ok(day.durationMinutes >= definition.minMinutes && day.durationMinutes <= definition.maxMinutes);
        assert.equal(day.steps.reduce((sum, step) => sum + step.minutes, 0), day.durationMinutes);
      }
    }
  }
});

test("validation rejects broken totals, schedules, budgets, and incompatible effort", () => {
  const plan = generateWeeklyPlan(summarizeTraining(history({ RUN: 60, BIKE: 120, SWIM: 40 }), now));
  for (const mutate of [
    value => { value.totalMinutes++; },
    value => { value.days[1].date = value.days[0].date; },
    value => { value.budgets.RUN.targetMinutes = 0; },
    value => { value.days[1].effort = "HARD"; },
    value => { value.days[1].steps[0].minutes++; },
    value => {
      const tuesdayWorkout = structuredClone(value.days[1]);
      const wednesdayWorkout = structuredClone(value.days[2]);
      value.days[1] = { ...wednesdayWorkout, date: tuesdayWorkout.date };
      value.days[2] = { ...tuesdayWorkout, date: wednesdayWorkout.date };
    },
  ]) {
    const changed = structuredClone(plan);
    mutate(changed);
    assert.throws(() => validateWeeklyPlan(changed));
  }
});

test("saved plans survive reads and regeneration replaces only the same user's week", async () => {
  await prisma.activity.createMany({ data: history({ RUN: 60 }).map(value => ({ ...value, userId: user.id })) });
  const first = await generateAndSaveWeeklyPlan(user.id, now);
  assert.deepEqual((await getPlannerState(user.id, now)).nextPlan.content, first.content);
  await prisma.activity.create({ data: { userId: user.id, ...activity("RUN", 30, previousDate(1)) } });
  const second = await generateAndSaveWeeklyPlan(user.id, now);
  assert.equal(second.id, first.id);
  assert.equal(await prisma.weeklyPlan.count(), 1);
  assert.ok(second.content.totalMinutes > first.content.totalMinutes);
});

test("concurrent generation keeps one saved plan and week rollover retains the current plan", async () => {
  const results = await Promise.all([generateAndSaveWeeklyPlan(user.id, now), generateAndSaveWeeklyPlan(user.id, now)]);
  assert.equal(results[0].id, results[1].id);
  assert.equal(await prisma.weeklyPlan.count(), 1);
  const rollover = await getPlannerState(user.id, new Date("2026-09-07T12:00:00Z"));
  assert.equal(rollover.currentPlan.id, results[0].id);
  assert.equal(rollover.nextPlan, null);
});

test("generation and reads are session-protected and ignore client-supplied user IDs and budgets", async () => {
  assert.equal((await generate(request("POST", "invalid"))).status, 401);
  assert.equal((await generate(request("POST", session, "https://unrelated.example"))).status, 403);
  assert.equal((await readPlan(request("GET", "invalid"))).status, 401);
  const other = await prisma.user.create({ data: { name: "Other" } });
  await generateAndSaveWeeklyPlan(other.id);
  const initial = await readPlan(request("GET"));
  assert.equal((await initial.json()).nextPlan, null);
  const response = await generate(request("POST", session, "http://localhost:3000", { userId: other.id, targetMinutes: 9999 }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const state = await response.json();
  assert.equal(state.nextPlan.content.totalMinutes, 40);
  assert.equal((await prisma.weeklyPlan.findUniqueOrThrow({ where: { id: state.nextPlan.id } })).userId, user.id);
});

test("generation waits for active activity sync without replacing an existing plan", async () => {
  const first = await generateAndSaveWeeklyPlan(user.id);
  const syncRun = await prisma.jobRun.create({ data: { userId: user.id, jobType: "STRAVA_SYNC", status: "PENDING", nextRetryAt: new Date(Date.now() + 60000) } });
  for (const status of ["PENDING", "RUNNING"]) {
    await prisma.jobRun.update({ where: { id: syncRun.id }, data: { status } });
    const response = await generate(request());
    assert.equal(response.status, 409);
    assert.deepEqual((await getPlannerState(user.id)).nextPlan.content, first.content);
  }
});

async function connectTestUser(userId) {
  await prisma.stravaConnection.create({ data: {
    userId, athleteId: 1000000 + userId, accessToken: "test-access", refreshToken: "test-refresh",
    expiresAt: new Date(Date.now() + 60000), scopes: ["activity:read_all"],
  } });
}

async function waitForTrainingLocks(userId, predicate) {
  const deadline = Date.now() + 3000;
  do {
    // The single-bigint advisory key is split into two unsigned 32-bit columns.
    const locks = await prisma.$queryRaw`
      SELECT granted FROM pg_locks
      WHERE locktype = 'advisory' AND classid::bigint = 4294967295
        AND objid::bigint = 4294967296 - ${userId}::bigint AND objsubid = 1
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
    if (predicate(locks)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.fail("Expected transaction lock ordering was not observed");
}

test("a sync arriving during plan generation cannot commit until the plan saves", async () => {
  await connectTestUser(user.id);
  const blocker = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await blocker.connect();
  let generation;
  let syncing;
  try {
    await blocker.query("BEGIN");
    // Pause the real generator at its write, after its active-sync check and reads.
    await blocker.query('LOCK TABLE "WeeklyPlan" IN SHARE MODE');
    generation = generateAndSaveWeeklyPlan(user.id, now).then(plan => ({ plan }), error => ({ error }));
    await waitForTrainingLocks(user.id, locks => locks.some(lock => lock.granted));
    syncing = createOrReuseSyncRun(user.id).then(run => ({ run }), error => ({ error }));
    await waitForTrainingLocks(user.id, locks => locks.some(lock => !lock.granted));
    assert.equal(await prisma.jobRun.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.weeklyPlan.count({ where: { userId: user.id } }), 0);
    await blocker.query("COMMIT");
    const planResult = await generation;
    const syncResult = await syncing;
    assert.ifError(planResult.error);
    assert.ifError(syncResult.error);
    assert.equal(syncResult.run.status, "PENDING");
    assert.equal((await getPlannerState(user.id, now)).nextPlan.id, planResult.plan.id);
  } finally {
    await blocker.query("ROLLBACK");
    await Promise.all([generation, syncing]);
    await blocker.end();
  }
});

test("a sync that wins the lock makes the concurrent generator reject after the sync commits", async () => {
  await connectTestUser(user.id);
  const blocker = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await blocker.connect();
  let generation;
  let syncing;
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock($1::bigint)", [-user.id]);
    syncing = createOrReuseSyncRun(user.id).then(run => ({ run }), error => ({ error }));
    await waitForTrainingLocks(user.id, locks => locks.filter(lock => !lock.granted).length === 1);
    generation = generateAndSaveWeeklyPlan(user.id, now).then(plan => ({ plan }), error => ({ error }));
    await waitForTrainingLocks(user.id, locks => locks.filter(lock => !lock.granted).length === 2);
    await blocker.query("COMMIT");
    assert.ifError((await syncing).error);
    assert.ok((await generation).error instanceof PlanSyncInProgressError);
    assert.equal(await prisma.weeklyPlan.count({ where: { userId: user.id } }), 0);
  } finally {
    await blocker.query("ROLLBACK");
    await Promise.all([generation, syncing]);
    await blocker.end();
  }
});

test("training locks are per user and do not serialize unrelated users", async () => {
  const other = await prisma.user.create({ data: { name: "Independent athlete" } });
  await connectTestUser(other.id);
  const blocker = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await blocker.connect();
  let generation;
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock($1::bigint)", [-user.id]);
    generation = generateAndSaveWeeklyPlan(user.id, now).then(plan => ({ plan }), error => ({ error }));
    await waitForTrainingLocks(user.id, locks => locks.some(lock => !lock.granted));
    const otherPlan = await generateAndSaveWeeklyPlan(other.id, now);
    assert.ok(otherPlan.id);
    assert.equal((await createOrReuseSyncRun(other.id)).status, "PENDING");
    await waitForTrainingLocks(user.id, locks => locks.some(lock => !lock.granted));
    await blocker.query("COMMIT");
    assert.ifError((await generation).error);
  } finally {
    await blocker.query("ROLLBACK");
    await generation;
    await blocker.end();
  }
});

test("failed plan writes roll back and release the lock so a sync can start", async () => {
  await connectTestUser(user.id);
  const original = await generateAndSaveWeeklyPlan(user.id, now);
  // NOT VALID preserves existing rows while forcing the next upsert to fail.
  await prisma.$executeRaw`ALTER TABLE "WeeklyPlan" ADD CONSTRAINT "reject_plan_test" CHECK (false) NOT VALID`;
  try {
    await assert.rejects(generateAndSaveWeeklyPlan(user.id, now));
    assert.deepEqual((await getPlannerState(user.id, now)).nextPlan, original);
    assert.equal((await createOrReuseSyncRun(user.id)).status, "PENDING");
  } finally {
    await prisma.$executeRaw`ALTER TABLE "WeeklyPlan" DROP CONSTRAINT "reject_plan_test"`;
  }
});

test("missing or failed sync is disclosed in the saved assumptions", async () => {
  const noSync = await generateAndSaveWeeklyPlan(user.id, now);
  assert.ok(noSync.content.assumptions.some(text => text.includes("No successful activity sync")));
  await prisma.stravaConnection.create({ data: { userId: user.id, athleteId: 901234,
    accessToken: "test-only-token", refreshToken: "test-only-refresh", expiresAt: now, scopes: ["activity:read_all"], lastSuccessfulSyncAt: now } });
  await prisma.jobRun.create({ data: { userId: user.id, jobType: "STRAVA_SYNC", status: "FAILED" } });
  const failed = await generateAndSaveWeeklyPlan(user.id, now);
  assert.ok(failed.content.assumptions.some(text => text.includes("latest sync failed")));
});

test("custom goals override history, zero skips a sport, and blank uses its average", () => {
  const summary = summarizeTraining(history({ RUN: 20, BIKE: 120, SWIM: 40 }), now);
  const goals = { RUN: 105, BIKE: null, SWIM: 0 };
  const plan = generateWeeklyPlan(summary, goals);
  assert.equal(plan.mode, "CUSTOM");
  assert.deepEqual(plan.goals, goals);
  assert.equal(plan.budgets.RUN.averageMinutes, 20);
  assert.equal(plan.budgets.RUN.plannedMinutes, 105);
  assert.equal(plan.budgets.BIKE.targetMinutes, 120);
  assert.equal(forSport(plan, "SWIM").length, 0);
  assert.equal(plan.totalMinutes, 225);
  assert.deepEqual(generateWeeklyPlan(summary, AUTOMATIC_WEEKLY_GOALS), generateWeeklyPlan(summary));
});

test("custom goals work without history, including an explicit all-rest week", () => {
  const summary = summarizeTraining([], now);
  const plan = generateWeeklyPlan(summary, { RUN: 30, BIKE: null, SWIM: null });
  assert.equal(plan.mode, "CUSTOM");
  assert.equal(plan.totalMinutes, 30);
  assert.ok(workouts(plan).every(day => day.sport === "RUN" && !day.optional));
  assert.equal(generateWeeklyPlan(summary, { RUN: 0, BIKE: 0, SWIM: 0 }).totalMinutes, 0);
});

test("custom targets retain requested totals and disclose unscheduled minutes", () => {
  const plan = generateWeeklyPlan(summarizeTraining([], now), { RUN: 150, BIKE: 200, SWIM: 100 });
  assert.deepEqual(Object.values(plan.budgets).map(budget => budget.targetMinutes), [150, 200, 100]);
  assert.deepEqual(Object.values(plan.budgets).map(budget => budget.plannedMinutes), [105, 180, 75]);
  assert.equal(plan.totalMinutes, 360);
  assert.equal(plan.assumptions.filter(text => text.includes("left unused")).length, 3);
  for (const sport of ["RUN", "BIKE", "SWIM"]) {
    for (let target = 0; target <= 200; target += 5) {
      const result = generateWeeklyPlan(summarizeTraining([], now), { RUN: 0, BIKE: 0, SWIM: 0, [sport]: target });
      const templates = WORKOUT_TEMPLATES.filter(template => template.sport === sport);
      const capacity = templates.reduce((sum, template) => sum + template.maxMinutes, 0);
      assert.equal(result.totalMinutes, target < templates[0].minMinutes ? 0 : Math.min(target, capacity));
    }
  }
});

test("goals validate strictly and plan validation checks the saved goal snapshot", () => {
  for (const RUN of [-5, 1, 12.5, 10085, Infinity, "30"]) {
    assert.equal(WeeklyGoalsSchema.safeParse({ RUN, BIKE: null, SWIM: null }).success, false);
  }
  assert.equal(WeeklyGoalsSchema.safeParse({ RUN: 30 }).success, false);
  const plan = generateWeeklyPlan(summarizeTraining([], now), { RUN: 30, BIKE: 0, SWIM: 0 });
  plan.goals.RUN = 35;
  assert.throws(() => validateWeeklyPlan(plan));
});

test("pre-settings plan snapshots remain readable", async () => {
  const legacy = generateWeeklyPlan(summarizeTraining([], now));
  delete legacy.goals;
  await prisma.weeklyPlan.create({ data: { userId: user.id, weekStart: new Date(legacy.weekStart), content: legacy } });
  const state = await getPlannerState(user.id, now);
  assert.deepEqual(state.goals, AUTOMATIC_WEEKLY_GOALS);
  assert.deepEqual(state.nextPlan.content.goals, AUTOMATIC_WEEKLY_GOALS);
  assert.equal(state.nextPlan.content.totalMinutes, 40);
});

test("goals persist per user and only affect a plan after regeneration", async () => {
  const other = await prisma.user.create({ data: { name: "Other goals" } });
  const first = await generateAndSaveWeeklyPlan(user.id, now);
  const goals = { RUN: 90, BIKE: 150, SWIM: 60 };
  await saveWeeklyGoals(user.id, goals);
  assert.deepEqual(await getWeeklyGoals(user.id), goals);
  assert.deepEqual(await getWeeklyGoals(other.id), AUTOMATIC_WEEKLY_GOALS);
  assert.deepEqual((await getPlannerState(user.id, now)).nextPlan.content, first.content);
  const next = await generateAndSaveWeeklyPlan(user.id, now);
  assert.equal(next.id, first.id);
  assert.equal(next.content.totalMinutes, 300);
  assert.deepEqual(next.content.goals, goals);
  await saveWeeklyGoals(user.id, AUTOMATIC_WEEKLY_GOALS);
  assert.equal((await generateAndSaveWeeklyPlan(user.id, now)).content.mode, "STARTER");
});

test("goal API checks sessions, origin, invalid JSON, and strict values without changing saved goals", async () => {
  const goals = { RUN: 90, BIKE: 150, SWIM: 60 };
  assert.equal((await configure(request("PATCH", "invalid", "http://localhost:3000", goals))).status, 401);
  assert.equal((await configure(request("PATCH", session, "https://unrelated.example", goals))).status, 403);
  const response = await configure(request("PATCH", session, "http://localhost:3000", goals));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual((await response.json()).goals, goals);
  for (const body of [{ ...goals, userId: user.id + 1 }, { ...goals, RUN: -5 }, { ...goals, BIKE: 12 }, { RUN: 10 }, {}]) {
    assert.equal((await configure(request("PATCH", session, "http://localhost:3000", body))).status, 400);
  }
  assert.equal((await configure(request("PATCH"))).status, 400);
  assert.deepEqual(await getWeeklyGoals(user.id), goals);
  const generated = await generate(request());
  assert.equal(generated.status, 200);
  assert.equal((await generated.json()).nextPlan.content.totalMinutes, 300);
  assert.deepEqual((await (await readPlan(request("GET"))).json()).goals, goals);
});
