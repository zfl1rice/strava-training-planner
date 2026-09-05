import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { NextRequest } from "next/server.js";
import { mondayUtc, trainingWindowStart, summarizeTraining } from "@pkg/shared";
import { prisma, getTrainingSummary, getSyncDashboard } from "@pkg/db";
import { GET as dashboard } from "../apps/web/src/app/api/strava/sync/route.ts";
import { hashToken, newOpaqueToken } from "../apps/web/src/lib/strava-auth.ts";

assert.match(process.env.OAUTH_TEST_DATABASE ?? "", /^planner_oauth_test_[a-f0-9]{16}$/);
assert.equal(new URL(process.env.DATABASE_URL).pathname, `/${process.env.OAUTH_TEST_DATABASE}`);
const now = new Date("2026-09-04T12:00:00Z");
const activity = (startedAt, type = "RUN", durationSeconds = 60, distanceMeters = 100) => ({
  startedAt: new Date(startedAt), type, durationSeconds, distanceMeters,
});
const totalSeconds = summary => summary.weeks.reduce((sum, week) => sum + week.totalDurationSeconds, 0);

beforeEach(async () => {
  await prisma.activity.deleteMany();
  await prisma.jobRun.deleteMany();
  await prisma.user.deleteMany();
});
after(async () => { await prisma.$disconnect(); });

test("calendar weeks start Monday UTC across year boundaries and leap days", () => {
  assert.equal(mondayUtc(new Date("2023-12-31T23:59:59Z")).toISOString(), "2023-12-25T00:00:00.000Z");
  assert.equal(mondayUtc(new Date("2024-01-01T00:00:00Z")).toISOString(), "2024-01-01T00:00:00.000Z");
  assert.equal(mondayUtc(new Date("2024-02-29T12:00:00Z")).toISOString(), "2024-02-26T00:00:00.000Z");
  assert.equal(trainingWindowStart(now).toISOString(), "2026-08-10T00:00:00.000Z");
});

test("offset timestamps and daylight saving changes use UTC rather than machine-local weeks", () => {
  const result = summarizeTraining([
    activity("2026-03-08T23:30:00-05:00"),
    activity("2026-03-08T18:30:00-05:00"),
  ], new Date("2026-03-10T00:00:00Z"));
  assert.equal(result.weeks[0].weekStart, "2026-03-09T00:00:00.000Z");
  assert.equal(result.weeks[0].run.activityCount, 1);
  assert.equal(result.weeks[1].run.activityCount, 1);
});

test("empty history returns four zero-filled weeks with a finite completed-week average", () => {
  const result = summarizeTraining([], now);
  assert.equal(result.weeks.length, 4);
  assert.deepEqual(result.weeks.map(week => week.isCurrentWeek), [true, false, false, false]);
  assert.equal(totalSeconds(result), 0);
  assert.equal(result.completedWeekAverageMinutes, 0);
  assert.equal(result.completedWeekCount, 3);
  assert.equal(result.generatedAt, now.toISOString());
});

test("half-open week boundaries avoid double counting and future/old activities are excluded", () => {
  const result = summarizeTraining([
    activity("2026-08-30T23:59:59.999Z", "RUN", 3600),
    activity("2026-08-31T00:00:00Z", "BIKE", 120),
    activity("2026-08-10T00:00:00Z", "SWIM", 180),
    activity("2026-08-09T23:59:59.999Z", "RUN", 9000),
    activity("2026-09-04T12:00:00Z", "RUN", 60),
    activity("2026-09-04T12:00:00.001Z", "RUN", 9000),
  ], now);
  assert.equal(result.weeks[0].totalDurationSeconds, 180);
  assert.equal(result.weeks[1].totalDurationSeconds, 3600);
  assert.equal(result.weeks[3].totalDurationSeconds, 180);
  assert.equal(totalSeconds(result), 3960);
  // The run crossing midnight remains in its starting week; its duration is not split.
  assert.equal(result.weeks[1].run.durationMinutes, 60);
});

test("sport totals preserve seconds and known distances, including null distances and other activities", () => {
  const result = summarizeTraining([
    activity(now, "RUN", 30, 500), activity(now, "RUN", 30, null),
    activity(now, "BIKE", 3600, 20000), activity(now, "SWIM", 900, 750),
    activity(now, "OTHER", 600, null),
  ], now);
  const week = result.weeks[0];
  assert.equal(week.run.durationMinutes, 1);
  assert.equal(week.run.distanceMeters, 500);
  assert.equal(week.run.missingDistanceCount, 1);
  assert.equal(week.run.activityCount, 2);
  assert.equal(week.bike.durationMinutes, 60);
  assert.equal(week.swim.durationMinutes, 15);
  assert.equal(week.other.durationMinutes, 10);
  assert.equal(week.totalDurationMinutes, 86);
  assert.equal(week.totalDurationSeconds, 5160);
});

test("recent-week average includes zero weeks and excludes the partial current week", () => {
  const result = summarizeTraining([
    activity(now, "RUN", 60000),
    activity("2026-08-25T12:00:00Z", "RUN", 3600),
    activity("2026-08-18T12:00:00Z", "BIKE", 7200),
  ], now);
  assert.equal(result.completedWeekAverageMinutes, 60);
});

test("database summary scopes to the user, window, and current time", async () => {
  const user = await prisma.user.create({ data: { name: "Training Test" } });
  const other = await prisma.user.create({ data: { name: "Other" } });
  await prisma.activity.createMany({ data: [
    { userId: user.id, ...activity(now, "RUN", 120, 400) },
    { userId: user.id, ...activity("2026-08-09T00:00:00Z", "RUN", 9000) },
    { userId: user.id, ...activity("2026-09-05T00:00:00Z", "RUN", 9000) },
    { userId: other.id, ...activity(now, "RUN", 9000) },
  ] });
  const summary = await getTrainingSummary(user.id, now);
  assert.equal(totalSeconds(summary), 120);
  assert.equal(summary.weeks[0].run.distanceMeters, 400);
});

test("dashboard summaries include more than the 30 displayed activities", async () => {
  const user = await prisma.user.create({ data: { name: "Training Test" } });
  await prisma.activity.createMany({ data: Array.from({ length: 35 }, () => ({
    userId: user.id, ...activity(new Date(Date.now() - 1000), "RUN", 60, 100),
  })) });
  const data = await getSyncDashboard(user.id);
  assert.equal(data.activities.length, 30);
  assert.equal(totalSeconds(data.trainingSummary), 2100);
  assert.equal(data.trainingSummary.weeks.reduce((sum, week) => sum + week.run.distanceMeters, 0), 3500);
});

test("authenticated status refresh recomputes summaries and blocks other users", async () => {
  const session = newOpaqueToken();
  const user = await prisma.user.create({ data: { name: "Training Test", sessions: { create: {
    tokenHash: hashToken(session), expiresAt: new Date(Date.now() + 600000),
  } } } });
  const other = await prisma.user.create({ data: { name: "Other" } });
  await prisma.activity.create({ data: { userId: other.id, ...activity(new Date(), "BIKE", 9000) } });
  const url = `http://localhost:3000/api/strava/sync?userId=${other.id}`;
  assert.equal((await dashboard(new NextRequest(url))).status, 401);
  const request = () => new NextRequest(url, { headers: { cookie: `planner_session=${session}` } });
  const initial = await dashboard(request());
  assert.equal(initial.headers.get("cache-control"), "no-store");
  assert.equal(totalSeconds((await initial.json()).trainingSummary), 0);
  const saved = await prisma.activity.create({ data: { userId: user.id, ...activity(new Date(), "SWIM", 600, null) } });
  assert.equal(totalSeconds((await (await dashboard(request())).json()).trainingSummary), 600);
  await prisma.activity.update({ where: { id: saved.id }, data: { durationSeconds: 1200 } });
  assert.equal(totalSeconds((await (await dashboard(request())).json()).trainingSummary), 1200);
});
