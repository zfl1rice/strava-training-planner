import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { NextRequest } from "next/server.js";
import { emptyAthleteProfile } from "@pkg/shared";
import {
  prisma, saveAthleteProfile, getPlanningSettings, buildPlanningContext,
  createRaceGoal, generateAndSaveWeeklyPlan,
} from "@pkg/db";
import { GET, PATCH } from "../apps/web/src/app/api/planning-settings/route.ts";
import { hashToken, newOpaqueToken } from "../apps/web/src/lib/strava-auth.ts";

assert.match(process.env.OAUTH_TEST_DATABASE ?? "", /^planner_oauth_test_[a-f0-9]{16}$/);
assert.equal(new URL(process.env.DATABASE_URL).pathname, `/${process.env.OAUTH_TEST_DATABASE}`);
const now = new Date("2026-09-06T12:00:00Z");
const manual = value => ({ value, recordedAt: "2026-09-01T00:00:00.000Z", evidenceIds: [], explanation: "Seeded baseline" });
const race = { name: "Two-minute race", eventType: "Time trial", date: "2026-10-01", sports: ["BIKE"],
  distanceMeters: null, expectedDurationSeconds: 120, performanceGoal: null, importance: 90 };
const closed = { availableMinutes: 0, maxSessions: 0, allowedSports: [], poolAccess: false };
let user, token;
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

function request(body, { session = token, origin = "http://localhost:3000", raw } = {}) {
  return new NextRequest("http://localhost:3000/api/planning-settings", {
    method: body === undefined && raw === undefined ? "GET" : "PATCH",
    headers: { origin, cookie: `planner_session=${session}`, "Content-Type": "application/json" },
    ...(raw !== undefined ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const profileChange = settings => ({ section: "PROFILE", expectedUpdatedAt: settings.profileUpdatedAt,
  timeZone: settings.timeZone, baselines: settings.baselines });

test("settings endpoint requires session and origin, rejects malformed/forged inputs, and never exposes secrets", async () => {
  assert.equal((await GET(request(undefined, { session: "invalid" }))).status, 401);
  const change = profileChange(await getPlanningSettings(user.id));
  assert.equal((await PATCH(request(change, { session: "invalid" }))).status, 401);
  assert.equal((await PATCH(request(change, { origin: "https://other.example" }))).status, 403);
  assert.equal((await PATCH(request(undefined, { raw: "{" }))).status, 400);
  assert.equal((await PATCH(request({ ...change, userId: user.id }))).status, 400);
  assert.equal((await PATCH(request({ ...change, capabilities: [] }))).status, 400);
  await prisma.stravaConnection.create({ data: { userId: user.id, athleteId: 654n, accessToken: "secret-access", refreshToken: "secret-refresh", expiresAt: now, scopes: [] } });
  const response = await GET(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(JSON.stringify(await response.json()), /accessToken|refreshToken|tokenHash|secret-access|secret-refresh/);
  assert.equal(await prisma.athleteProfile.count(), 0);
});

test("manual baseline edits preserve estimates, custom zones, restrictions, and history; clearing restores estimate", async () => {
  const profile = emptyAthleteProfile();
  profile.fitness.cycling.baseline = { manual: manual(230), estimate: manual(220) };
  profile.fitness.cycling.zones = { mode: "CUSTOM", unit: "WATTS", boundaries: [{ label: "Custom", lower: 0, upper: null }] };
  profile.restrictions = [{ id: "run-pause", sport: "RUN", kind: "NO_TRAINING", maxSessionMinutes: null,
    startDate: "2026-09-01", endDate: null, description: "No running" }];
  profile.availability.recurring = [{ weekday: 0, settings: closed }];
  await saveAthleteProfile(user.id, profile, "UTC");
  let settings = await getPlanningSettings(user.id);
  const response = await PATCH(request({ ...profileChange(settings), timeZone: "America/Chicago", baselines: { ...settings.baselines, cyclingFtp: 250 } }));
  assert.equal(response.status, 200);
  settings = await response.json();
  const saved = (await prisma.athleteProfile.findUniqueOrThrow({ where: { userId: user.id } })).content;
  assert.deepEqual(saved.fitness.cycling.baseline.estimate, profile.fitness.cycling.baseline.estimate);
  assert.deepEqual(saved.fitness.cycling.zones, profile.fitness.cycling.zones);
  assert.deepEqual(saved.restrictions, profile.restrictions);
  assert.deepEqual(saved.availability, profile.availability);
  assert.equal((await buildPlanningContext(user.id, { now })).fitness.effective.cycling.value, 250);
  assert.equal((await PATCH(request({ ...profileChange(settings), baselines: { ...settings.baselines, cyclingFtp: null } }))).status, 200);
  assert.equal((await buildPlanningContext(user.id, { now })).fitness.effective.cycling.value, 220);
});

test("availability edits flow into context, override recurring dates, and leave saved plans and fitness intact", async () => {
  const profile = emptyAthleteProfile();
  profile.fitness.cycling.baseline.manual = manual(250);
  await saveAthleteProfile(user.id, profile, "America/Chicago");
  const plan = await generateAndSaveWeeklyPlan(user.id, now);
  const settings = await getPlanningSettings(user.id);
  const availability = { recurring: [{ weekday: 0, settings: { availableMinutes: 90, maxSessions: 2, allowedSports: ["SWIM"], poolAccess: true } }],
    overrides: [{ date: "2026-09-07", settings: closed, note: "Pool closed" }] };
  const response = await PATCH(request({ section: "AVAILABILITY", expectedUpdatedAt: settings.profileUpdatedAt, availability }));
  assert.equal(response.status, 200);
  const context = await buildPlanningContext(user.id, { now });
  assert.equal(context.availability.days[0].source, "OVERRIDE");
  assert.equal(context.availability.days[0].settings.availableMinutes, 0);
  assert.equal(context.fitness.effective.cycling.value, 250);
  assert.deepEqual(context.existingPlans[0].content, plan.content);
  const invalid = { ...availability, overrides: [...availability.overrides, availability.overrides[0]] };
  const updated = await response.json();
  assert.equal((await PATCH(request({ section: "AVAILABILITY", expectedUpdatedAt: updated.profileUpdatedAt, availability: invalid }))).status, 400);
  assert.deepEqual((await getPlanningSettings(user.id)).availability, availability);
});

test("first profile creation and concurrent tabs cannot silently overwrite newer settings", async () => {
  const initial = await getPlanningSettings(user.id);
  const first = await PATCH(request(profileChange(initial)));
  assert.equal(first.status, 200);
  assert.equal((await PATCH(request(profileChange(initial)))).status, 409);
  const saved = await first.json();
  const responses = await Promise.all([
    PATCH(request({ ...profileChange(saved), baselines: { ...saved.baselines, cyclingFtp: 260 } })),
    PATCH(request({ section: "AVAILABILITY", expectedUpdatedAt: saved.profileUpdatedAt, availability: { recurring: [{ weekday: 1, settings: closed }], overrides: [] } })),
  ]);
  assert.deepEqual(responses.map(value => value.status).sort(), [200, 409]);
});

test("race CRUD supports equal importance, updates context, and scopes ownership", async () => {
  const other = await prisma.user.create({ data: {} });
  const privateId = await createRaceGoal(other.id, { ...race, name: "Private", demandProfile: null });
  assert.equal((await PATCH(request({ section: "RACE_CREATE", race }))).status, 200);
  const response = await PATCH(request({ section: "RACE_CREATE", race: { ...race, name: "Second race" } }));
  assert.equal(response.status, 200);
  const settings = await response.json();
  assert.deepEqual(settings.races.map(value => value.race.importance), [90, 90]);
  const first = settings.races[0];
  assert.equal((await PATCH(request({ section: "RACE_UPDATE", id: privateId, expectedUpdatedAt: first.updatedAt, race }))).status, 404);
  assert.equal((await PATCH(request({ section: "RACE_DELETE", id: privateId, expectedUpdatedAt: first.updatedAt }))).status, 404);
  const edited = await PATCH(request({ section: "RACE_UPDATE", id: first.id, expectedUpdatedAt: first.updatedAt, race: { ...first.race, importance: 25 } }));
  assert.equal(edited.status, 200);
  const updated = (await edited.json()).races.find(value => value.id === first.id);
  assert.equal((await PATCH(request({ section: "RACE_DELETE", id: first.id, expectedUpdatedAt: first.updatedAt }))).status, 409);
  assert.equal((await PATCH(request({ section: "RACE_DELETE", id: first.id, expectedUpdatedAt: updated.updatedAt }))).status, 200);
  assert.deepEqual((await buildPlanningContext(user.id, { now })).races.map(value => value.goal.name), ["Second race"]);
  assert.equal(await prisma.raceGoal.count({ where: { userId: other.id } }), 1);
});

test("changing race demands invalidates the stored profile; changing importance preserves it", async () => {
  const demandProfile = { version: 1, source: "USER", generatorVersion: "seed-v1", generatedAt: now.toISOString(), explanation: "Short cycling event",
    weights: [{ sport: "BIKE", capability: "SHORT_ANAEROBIC", weight: 100 }] };
  const id = await createRaceGoal(user.id, { ...race, demandProfile });
  let settings = await getPlanningSettings(user.id);
  let entry = settings.races[0];
  let response = await PATCH(request({ section: "RACE_UPDATE", id, expectedUpdatedAt: entry.updatedAt, race: { ...entry.race, importance: 50 } }));
  assert.equal(response.status, 200);
  assert.deepEqual((await prisma.raceGoal.findUniqueOrThrow({ where: { id } })).content.demandProfile, demandProfile);
  settings = await response.json(); entry = settings.races[0];
  response = await PATCH(request({ section: "RACE_UPDATE", id, expectedUpdatedAt: entry.updatedAt, race: { ...entry.race, expectedDurationSeconds: 3600 } }));
  assert.equal(response.status, 200);
  assert.equal((await prisma.raceGoal.findUniqueOrThrow({ where: { id } })).content.demandProfile, null);
  assert.equal((await PATCH(request({ section: "RACE_CREATE", race: { ...race, demandProfile } }))).status, 400);
});

test("swim units cannot relabel estimates or custom zones, and invalid baseline/date values do not write", async () => {
  const profile = emptyAthleteProfile();
  profile.fitness.swimming.baseline.estimate = manual(100);
  await saveAthleteProfile(user.id, profile, "UTC");
  const settings = await getPlanningSettings(user.id);
  assert.equal(settings.swimUnitLocked, true);
  assert.equal((await PATCH(request({ ...profileChange(settings), baselines: { ...settings.baselines, swimPaceUnit: "SECONDS_PER_100YD" } }))).status, 400);
  assert.equal((await PATCH(request({ ...profileChange(settings), baselines: { ...settings.baselines, runningMaxHr: -5 } }))).status, 400);
  assert.equal((await PATCH(request({ ...profileChange(settings), timeZone: "Not/AZone" }))).status, 400);
  assert.equal((await PATCH(request({ section: "RACE_CREATE", race: { ...race, date: "2026-02-30" } }))).status, 400);
  assert.deepEqual(await getPlanningSettings(user.id), settings);
});
