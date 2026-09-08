import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server.js";
import {
  TrainingFocusSchema, normalizeTrainingFocus, emptyAthleteProfile, calendarWorkouts,
  clearableWorkouts, removeEligibleWeekWorkouts, validateStoredPlan, calendarMonday, localDateAt,
} from "@pkg/shared";
import {
  prisma, saveTrainingFocus, saveWeeklyGoals, saveAthleteProfile, getTrainingBlockState,
  createInitialTrainingBlock, getDevelopmentBlock, generateAndSaveFlexiblePlan, generateAndSaveWeeklyPlan,
  saveWorkoutStates, clearPlannedWeek, createRaceGoal, buildBlockPlanningContext, recordBlockReview,
} from "@pkg/db";
import { POST as updateBlock } from "../apps/web/src/app/api/training-block/route.ts";
import { DELETE as clearWeek } from "../apps/web/src/app/api/calendar/route.ts";
import { BlockSummary } from "../apps/web/src/app/training-block-panel.tsx";
import { reviewWeekLabel } from "../apps/web/src/app/training-block-labels.ts";
import { hashToken, newOpaqueToken } from "../apps/web/src/lib/strava-auth.ts";

globalThis.React = React; // tsx preserves the app's JSX for this server-render smoke.
assert.match(process.env.OAUTH_TEST_DATABASE ?? "", /^planner_oauth_test_[a-f0-9]{16}$/);
assert.equal(new URL(process.env.DATABASE_URL).pathname, `/${process.env.OAUTH_TEST_DATABASE}`);
const monday = new Date("2026-09-07T12:00:00Z");
let user, token;
beforeEach(async () => {
  await prisma.activity.deleteMany(); await prisma.jobRun.deleteMany(); await prisma.user.deleteMany();
  token = newOpaqueToken();
  user = await prisma.user.create({ data: { sessions: { create: { tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3600000) } } } });
  await saveWeeklyGoals(user.id, { RUN: 120, BIKE: 240, SWIM: 60 });
});
after(async () => { await prisma.$disconnect(); });
const request = (body, method = "POST", origin = "http://localhost:3000", session = token) => new NextRequest("http://localhost:3000/api/training-block", {
  method, headers: { origin, cookie: `planner_session=${session}`, "content-type": "application/json" }, body: JSON.stringify(body),
});
const saveFocus = async focus => saveTrainingFocus(user.id, focus, (await getTrainingBlockState(user.id)).profileUpdatedAt);
const clearRequest = (plan, today = "2026-09-07") => ({ planId: plan.id, expectedUpdatedAt: plan.updatedAt, today });
const savedRow = async id => {
  const row = await prisma.weeklyPlan.findUniqueOrThrow({ where: { id } });
  return { id, updatedAt: row.updatedAt.toISOString(), content: validateStoredPlan(row.content), workoutStates: row.workoutStates };
};

test("focus validation rejects malformed percentages and normalization always totals exactly 100", () => {
  for (const value of [{ RUN: 0, BIKE: 0, SWIM: 0 }, { RUN: -1, BIKE: 81, SWIM: 20 }, { RUN: 30.5, BIKE: 49.5, SWIM: 20 }, { RUN: 30, BIKE: 50 }, { RUN: 30, BIKE: 50, SWIM: 20, other: 1 }]) assert.equal(TrainingFocusSchema.safeParse(value).success, false);
  assert.throws(() => normalizeTrainingFocus({ RUN: 0, BIKE: 0, SWIM: 0 }));
  assert.deepEqual(normalizeTrainingFocus({ RUN: 30, BIKE: 50, SWIM: 20 }), { RUN: 30, BIKE: 50, SWIM: 20 });
  assert.deepEqual(normalizeTrainingFocus({ RUN: 1, BIKE: 1, SWIM: 1 }), { RUN: 34, BIKE: 33, SWIM: 33 });
  for (let run = 0; run <= 100; run++) {
    const focus = normalizeTrainingFocus({ RUN: run, BIKE: 61, SWIM: 17 });
    assert.equal(Object.values(focus).reduce((a, b) => a + b), 100);
    assert.deepEqual(normalizeTrainingFocus(focus), focus);
  }
});

test("focus persists independently of goals, fitness, availability, and existing block history", async () => {
  const profile = emptyAthleteProfile();
  profile.availability.overrides = [{ date: "2026-09-08", note: "Away", settings: { availableMinutes: 0, maxSessions: 0, allowedSports: [], poolAccess: false } }];
  await saveAthleteProfile(user.id, profile, "UTC");
  const block = await createInitialTrainingBlock(user.id, false, monday);
  const original = await prisma.athleteProfile.findUniqueOrThrow({ where: { userId: user.id } });
  await saveFocus({ RUN: 30, BIKE: 50, SWIM: 20 });
  const state = await getTrainingBlockState(user.id, monday);
  assert.deepEqual(state.trainingFocus, { RUN: 30, BIKE: 50, SWIM: 20 });
  assert.deepEqual(state.block, block);
  const stored = await prisma.athleteProfile.findUniqueOrThrow({ where: { userId: user.id } });
  assert.deepEqual(stored.content, { ...original.content, trainingFocus: state.trainingFocus });
  await assert.rejects(saveTrainingFocus(user.id, { RUN: 50, BIKE: 30, SWIM: 20 }, original.updatedAt.toISOString()), /changed/);
  const context = await buildBlockPlanningContext(user.id, { startDate: "2026-09-07", phase: "GENERAL_PREPARATION", rationale: "Test", raceIds: [] }, monday);
  assert.deepEqual(context.goals, { RUN: 120, BIKE: 240, SWIM: 60 });
  assert.deepEqual(context.trainingFocus, state.trainingFocus);
});

test("new blocks and explicit replans use current focus and preserve prior reviews and workouts", async () => {
  await saveFocus({ RUN: 30, BIKE: 50, SWIM: 20 });
  const first = await createInitialTrainingBlock(user.id, false, monday);
  assert.equal(first.proposal.focuses.find(focus => focus.role === "PRIMARY").sport, "BIKE");
  const plan = await generateAndSaveFlexiblePlan(user.id, monday, "REMAINING_WEEK");
  await recordBlockReview(user.id, first.id, first.revision, { decision: "HOLD", reviewedWeekStart: "2026-09-07", effectiveWeekStart: "2026-09-14", rationale: "Keep training steady." }, monday);
  const before = await getDevelopmentBlock(user.id, first.id);
  await saveFocus({ RUN: 70, BIKE: 20, SWIM: 10 });
  assert.equal((await createInitialTrainingBlock(user.id, false, monday)).id, first.id);
  const replacement = await createInitialTrainingBlock(user.id, true, monday);
  assert.equal(replacement.proposal.focuses.find(focus => focus.role === "PRIMARY").sport, "RUN");
  assert.match(replacement.proposal.focuses[0].rationale, /70%/);
  const historical = await getDevelopmentBlock(user.id, first.id);
  assert.equal(historical.status, "ABORTED");
  assert.deepEqual(historical.reviews, before.reviews);
  assert.deepEqual((await savedRow(plan.id)).content, plan.content);
});

test("excluded sports and race demands take precedence over preferences", async () => {
  await saveFocus({ RUN: 0, BIKE: 0, SWIM: 100 });
  await saveWeeklyGoals(user.id, { RUN: 120, BIKE: 240, SWIM: 0 });
  const first = await createInitialTrainingBlock(user.id, false, monday);
  assert.ok(first.proposal.focuses.every(focus => focus.sport !== "SWIM"));
  await createRaceGoal(user.id, { name: "Short run", date: "2026-09-12", importance: 100, sports: ["RUN"], eventType: "800m", distanceMeters: 800, expectedDurationSeconds: 120, performanceGoal: null, demandProfile: null });
  const replacement = await createInitialTrainingBlock(user.id, true, monday);
  const primary = replacement.proposal.focuses.find(focus => focus.role === "PRIMARY");
  assert.equal(primary.sport, "RUN"); assert.equal(primary.capability, "SPEED");
  assert.match(primary.rationale, /Short run/);
});

test("focus endpoint validates session, origin, payload and profile revision", async () => {
  const body = { action: "SAVE_FOCUS", focus: { RUN: 30, BIKE: 50, SWIM: 20 }, expectedUpdatedAt: null };
  assert.equal((await updateBlock(request(body, "POST", "http://evil.test"))).status, 403);
  assert.equal((await updateBlock(request(body, "POST", "http://localhost:3000", "invalid"))).status, 401);
  assert.equal((await updateBlock(request({ ...body, focus: { RUN: 0, BIKE: 0, SWIM: 0 } }))).status, 400);
  const response = await updateBlock(request(body));
  assert.equal(response.status, 202); assert.deepEqual((await response.json()).trainingFocus, body.focus);
  assert.equal((await updateBlock(request(body))).status, 409);
});

test("clear retains past, completed, modified, stopped, locked and feedback-bearing workouts verbatim", async () => {
  const plan = await generateAndSaveFlexiblePlan(user.id, monday, "REMAINING_WEEK");
  const workouts = calendarWorkouts(plan.content);
  assert.ok(workouts.length >= 6);
  const states = workouts.slice(1, 6).map((workout, index) => ({ workoutId: workout.id, date: workout.date, templateId: workout.templateId ?? "custom", locked: index === 3,
    completion: ["COMPLETED", "MODIFIED", "STOPPED", "PLANNED", "PLANNED"][index], feedback: index === 4 ? { comment: "I struggled today", rpe: 8 } : null }));
  await saveWorkoutStates(user.id, plan.id, plan.updatedAt, states);
  const saved = await savedRow(plan.id);
  const today = "2026-09-08";
  const expected = clearableWorkouts(saved, today);
  const cleared = removeEligibleWeekWorkouts(saved, today);
  assert.equal(cleared.removedCount, expected.length);
  assert.deepEqual(cleared.workoutStates, states);
  for (const workout of workouts.filter(workout => !expected.some(value => value.id === workout.id))) {
    assert.deepEqual(calendarWorkouts(cleared.content).find(value => value.id === workout.id), workout);
  }
  assert.deepEqual(cleared.content.goals, saved.content.goals);
});

test("clear writes only the selected plan; history survives and the week can regenerate", async () => {
  const block = await createInitialTrainingBlock(user.id, false, monday);
  const plan = await generateAndSaveFlexiblePlan(user.id, monday, "REMAINING_WEEK");
  const previous = await generateAndSaveWeeklyPlan(user.id, new Date("2026-08-28T12:00:00Z"));
  await prisma.activity.createMany({ data: [{ userId: user.id, type: "RUN", startedAt: monday, durationSeconds: 1800 }, { userId: user.id, type: "BIKE", startedAt: monday, durationSeconds: 3600, stravaActivityId: 123n }] });
  const activities = await prisma.activity.findMany();
  const original = await savedRow(plan.id);
  const workout = calendarWorkouts(original.content)[0];
  await saveWorkoutStates(user.id, plan.id, original.updatedAt, [{ workoutId: workout.id, templateId: workout.templateId ?? "custom", date: workout.date, locked: false, completion: "COMPLETED", feedback: null }]);
  const saved = await savedRow(plan.id);
  await recordBlockReview(user.id, block.id, block.revision, { decision: "HOLD", reviewedWeekStart: "2026-09-07", effectiveWeekStart: "2026-09-14", rationale: "Keep the current focus." }, monday);
  const history = await getDevelopmentBlock(user.id, block.id);
  const result = await clearPlannedWeek(user.id, clearRequest(saved), monday);
  assert.equal(result.removedCount, calendarWorkouts(saved.content).length - 1);
  assert.equal(calendarWorkouts((await savedRow(plan.id)).content).length, 1);
  assert.deepEqual((await savedRow(previous.id)).content, previous.content);
  assert.deepEqual(await prisma.activity.findMany(), activities);
  assert.deepEqual(await getDevelopmentBlock(user.id, block.id), history);
  const regenerated = await generateAndSaveFlexiblePlan(user.id, monday, "REMAINING_WEEK");
  assert.equal(regenerated.id, plan.id);
  assert.ok(calendarWorkouts(regenerated.content).length > 1);
  assert.deepEqual(calendarWorkouts(regenerated.content).find(value => value.id === workout.id), workout);
});

test("legacy plans clear without format migration and wholly past plans stay untouched", async () => {
  const plan = await generateAndSaveWeeklyPlan(user.id, new Date("2026-09-06T12:00:00Z"));
  assert.ok((await clearPlannedWeek(user.id, clearRequest(plan), monday)).removedCount > 0);
  const cleared = await savedRow(plan.id);
  assert.equal(cleared.content.version, 1); assert.equal(cleared.content.totalMinutes, 0);
  const past = await generateAndSaveWeeklyPlan(user.id, new Date("2026-08-28T12:00:00Z"));
  assert.equal((await clearPlannedWeek(user.id, clearRequest(past), monday)).removedCount, 0);
  assert.equal((await savedRow(past.id)).updatedAt, past.updatedAt);
});

test("clear rejects stale plans, midnight rollovers, other athletes, and active jobs", async () => {
  const plan = await generateAndSaveFlexiblePlan(user.id, monday, "REMAINING_WEEK");
  await assert.rejects(clearPlannedWeek(user.id, { ...clearRequest(plan), expectedUpdatedAt: "2000-01-01T00:00:00.000Z" }, monday), /changed/);
  await assert.rejects(clearPlannedWeek(user.id, clearRequest(plan), new Date("2026-09-08T00:00:00Z")), /date changed/);
  const other = await prisma.user.create({ data: {} });
  await assert.rejects(clearPlannedWeek(other.id, clearRequest(plan), monday), /changed/);
  for (const jobType of ["COMPUTE_PLAN", "REVIEW_BLOCK", "STRAVA_SYNC"]) {
    const job = await prisma.jobRun.create({ data: { userId: user.id, jobType } });
    await assert.rejects(clearPlannedWeek(user.id, clearRequest(plan), monday), /finish/);
    await prisma.jobRun.delete({ where: { id: job.id } });
  }
  assert.deepEqual((await savedRow(plan.id)).content, plan.content);
});

test("clear endpoint checks session and origin and uses athlete-local dates", async () => {
  await prisma.user.update({ where: { id: user.id }, data: { timeZone: "America/Chicago" } });
  const now = new Date();
  const today = localDateAt(now, "America/Chicago");
  const plan = await generateAndSaveFlexiblePlan(user.id, now, "REMAINING_WEEK");
  const body = clearRequest(plan, today);
  assert.equal((await clearWeek(request(body, "DELETE", "http://evil.test"))).status, 403);
  assert.equal((await clearWeek(request(body, "DELETE", "http://localhost:3000", "invalid"))).status, 401);
  assert.equal((await clearWeek(request({ ...body, userId: user.id }, "DELETE"))).status, 400);
  assert.equal((await clearWeek(request(body, "DELETE"))).status, 200);
});

test("emphasis renders saved reasons, readable strategies and collapsed sections; review labels follow calendar completion", async () => {
  await saveFocus({ RUN: 30, BIKE: 50, SWIM: 20 });
  await createInitialTrainingBlock(user.id, false, monday);
  const state = await getTrainingBlockState(user.id, monday);
  const html = renderToStaticMarkup(React.createElement(BlockSummary, { state }));
  assert.match(html, /Current emphasis/); assert.match(html, /Week structure/);
  assert.match(html, /Week 1 of 4/); assert.match(html, /Bike.*Long endurance/);
  assert.match(html, /Increase long-session duration/); assert.match(html, /Maintain current exposure/);
  assert.match(html, /saved 50% emphasis/);
  assert.doesNotMatch(html, /LONG_ENDURANCE|LONG_SESSION|TIME_AT_INTENSITY|PRIMARY|MAINTENANCE/);
  assert.doesNotMatch(html, /<details[^>]*open/);
  const bikeOnly = structuredClone(state);
  bikeOnly.block.proposal.focuses = bikeOnly.block.proposal.focuses.filter(focus => focus.sport === "BIKE");
  const reduced = renderToStaticMarkup(React.createElement(BlockSummary, { state: bikeOnly }));
  assert.match(reduced, /Swim — No active focus/);
  assert.match(reduced, /No progression assigned/);
  assert.equal(reviewWeekLabel("2026-09-07", "2026-09-07"), "Review progress so far");
  assert.equal(reviewWeekLabel("2026-08-31", "2026-09-07"), "Review Week");
  assert.equal(calendarMonday("2026-09-13"), "2026-09-07");
});
