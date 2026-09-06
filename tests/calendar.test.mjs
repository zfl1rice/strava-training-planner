import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { NextRequest } from "next/server.js";
import { CalendarMonthSchema, calendarMonthRange } from "@pkg/shared";
import { prisma, getTrainingCalendar, generateAndSaveWeeklyPlan } from "@pkg/db";
import { GET } from "../apps/web/src/app/api/calendar/route.ts";
import { hashToken, newOpaqueToken } from "../apps/web/src/lib/strava-auth.ts";

assert.match(process.env.OAUTH_TEST_DATABASE ?? "", /^planner_oauth_test_[a-f0-9]{16}$/);
assert.equal(new URL(process.env.DATABASE_URL).pathname, `/${process.env.OAUTH_TEST_DATABASE}`);
let user;
let token;
beforeEach(async () => {
  await prisma.activity.deleteMany();
  await prisma.jobRun.deleteMany();
  await prisma.user.deleteMany();
  token = newOpaqueToken();
  user = await prisma.user.create({ data: { sessions: { create: {
    tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 600000),
  } } } });
});
after(async () => { await prisma.$disconnect(); });

function request(month, session = token, extra = "") {
  return new NextRequest(`http://localhost:3000/api/calendar?month=${month}${extra}`, {
    headers: { cookie: `planner_session=${session}` },
  });
}

test("calendar ranges include complete UTC weeks across month, year, and leap-day boundaries", () => {
  for (const [month, start, end] of [
    ["2026-09", "2026-08-31", "2026-10-05"],
    ["2026-02", "2026-01-26", "2026-03-02"],
    ["2021-02", "2021-02-01", "2021-03-01"],
    ["2024-02", "2024-01-29", "2024-03-04"],
    ["2026-03", "2026-02-23", "2026-04-06"],
    ["2026-12", "2026-11-30", "2027-01-04"],
  ]) {
    const range = calendarMonthRange(month);
    assert.equal(range.start.toISOString(), `${start}T00:00:00.000Z`);
    assert.equal(range.end.toISOString(), `${end}T00:00:00.000Z`);
  }
});

test("malformed and out-of-range months are rejected", async () => {
  for (const month of ["", "2026-00", "2026-13", "2026-9", "2026-09-01", "0000-01", "2200-01"]) {
    assert.equal(CalendarMonthSchema.safeParse(month).success, false);
    assert.equal((await GET(request(month))).status, 400);
  }
});

test("calendar requires a session and ignores a caller-supplied user ID", async () => {
  const other = await prisma.user.create({ data: {} });
  await prisma.activity.create({ data: { userId: other.id, type: "RUN", name: "Private run", startedAt: new Date("2026-09-05T12:00:00Z"), durationSeconds: 1800 } });
  assert.equal((await GET(request("2026-09", "invalid"))).status, 401);
  const response = await GET(request("2026-09", token, `&userId=${other.id}`));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { month: "2026-09", activities: [], plans: [] });
});

test("calendar returns all visible activities, including more than 30, with an exclusive end boundary", async () => {
  await prisma.activity.createMany({ data: [
    ...Array.from({ length: 35 }, (_, index) => ({ userId: user.id, type: "RUN", name: `Run ${index}`, startedAt: new Date("2026-09-05T12:00:00Z"), durationSeconds: 60 })),
    { userId: user.id, type: "SWIM", startedAt: new Date("2026-08-31T00:00:00Z"), durationSeconds: 600, stravaActivityId: 1234567890123n },
    { userId: user.id, type: "BIKE", startedAt: new Date("2026-10-04T23:59:59Z"), durationSeconds: 900 },
    { userId: user.id, type: "BIKE", startedAt: new Date("2026-10-05T00:00:00Z"), durationSeconds: 9999 },
    { userId: user.id, type: "BIKE", startedAt: new Date("2026-08-30T23:59:59Z"), durationSeconds: 9999 },
  ] });
  const data = await getTrainingCalendar(user.id, "2026-09");
  assert.equal(data.activities.length, 37);
  assert.equal(data.activities[0].stravaActivityId, "1234567890123");
  assert.equal(data.activities[0].distanceMeters, null);
  assert.ok(data.activities.every(activity => activity.durationSeconds !== 9999));
  assert.doesNotThrow(() => JSON.stringify(data));
});

test("calendar loads historical saved plans and retains planned workouts alongside completed activities", async () => {
  const saved = await generateAndSaveWeeklyPlan(user.id, new Date("2026-08-28T12:00:00Z"));
  const workout = saved.content.days.find(day => day.kind === "WORKOUT");
  await prisma.activity.create({ data: { userId: user.id, type: workout.sport, startedAt: new Date(`${workout.date}T12:00:00Z`), durationSeconds: workout.durationMinutes * 60 } });
  const other = await prisma.user.create({ data: {} });
  await generateAndSaveWeeklyPlan(other.id, new Date("2026-08-28T12:00:00Z"));
  await generateAndSaveWeeklyPlan(user.id, new Date("2026-10-09T12:00:00Z"));
  const response = await GET(request("2026-09"));
  const data = await response.json();
  assert.equal(data.plans.length, 1);
  assert.equal(data.plans[0].id, saved.id);
  assert.deepEqual(data.plans[0].content, saved.content);
  assert.equal(data.activities.length, 1);
  assert.equal(data.activities[0].startedAt.slice(0, 10), workout.date);
});
