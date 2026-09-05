import assert from "node:assert/strict";
import { once } from "node:events";
import { after, beforeEach, mock, test } from "node:test";
import { NextRequest } from "next/server.js";
import { Queue, QueueEvents, Worker, Job } from "bullmq";
import { prisma, createOrReuseSyncRun } from "@pkg/db";
import { bullConnectionFromUrl, JOBS, QUEUES, syncJobId, SyncAthleteJobSchema } from "@pkg/shared";
import { StravaApiError, stravaRateLimitDelay } from "@pkg/shared/strava";
import { processJob, stravaBackoff } from "../apps/worker/dist/processor.js";
import { POST as enqueue, GET as status } from "../apps/web/src/app/api/strava/sync/route.ts";
import { hashToken, newOpaqueToken } from "../apps/web/src/lib/strava-auth.ts";
import { getSyncQueue } from "../apps/web/src/lib/queue.ts";

assert.match(process.env.OAUTH_TEST_DATABASE ?? "", /^planner_oauth_test_[a-f0-9]{16}$/);
assert.equal(new URL(process.env.DATABASE_URL).pathname, `/${process.env.OAUTH_TEST_DATABASE}`);
assert.equal(process.env.BULLMQ_PREFIX, process.env.OAUTH_TEST_DATABASE);
const options = { connection: bullConnectionFromUrl(process.env.REDIS_URL), prefix: process.env.BULLMQ_PREFIX };
const queue = new Queue(QUEUES.jobs, options);
const events = new QueueEvents(QUEUES.jobs, options);
await events.waitUntilReady();
let worker;
let user;
let session;
const origin = "http://localhost:3000";
const athleteId = 901234;
const future = () => new Date(Date.now() + 21600000);
const activity = (id, sport = "Run", extra = {}) => ({
  id, athlete: { id: athleteId }, name: `Test ${sport}`, type: sport, sport_type: sport,
  start_date: new Date(Date.now() - 86400000).toISOString(), moving_time: 1800,
  distance: 5000.4, total_elevation_gain: 34.7, ...extra,
});

beforeEach(async () => {
  if (worker) { await worker.close(); worker = undefined; }
  // The random prefix is dedicated to this harness; never clear the app's queue.
  await queue.obliterate({ force: true });
  mock.restoreAll();
  await prisma.activity.deleteMany();
  await prisma.jobRun.deleteMany();
  await prisma.user.deleteMany();
  session = newOpaqueToken();
  user = await prisma.user.create({ data: { name: "Sync Test", stravaConnection: { create: {
    athleteId, accessToken: "test-access", refreshToken: "test-refresh", expiresAt: future(), scopes: ["activity:read_all"],
  } }, sessions: { create: { tokenHash: hashToken(session), expiresAt: future() } } } });
  mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected external request in sync test"); });
});

after(async () => {
  if (worker) await worker.close();
  await queue.obliterate({ force: true });
  await events.close();
  await queue.close();
  await globalThis.syncQueue?.close();
  await prisma.$disconnect();
  mock.restoreAll();
});

function request(method = "POST", token = session, requestOrigin = origin, body) {
  return new NextRequest(`${origin}/api/strava/sync`, { method, headers: {
    origin: requestOrigin, cookie: `planner_session=${token}`,
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
}

async function queued() {
  const response = await enqueue(request());
  assert.equal(response.status, 202, await response.clone().text());
  const { jobRunId } = await response.json();
  const job = await Job.fromId(queue, syncJobId(jobRunId));
  assert.ok(job);
  return { job, jobRunId };
}

async function startWorker() {
  worker = new Worker(QUEUES.jobs, processJob, { ...options, settings: { backoffStrategy: stravaBackoff } });
  await worker.waitUntilReady();
}

function pages(getPage) {
  return mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin, "https://www.strava.com");
    assert.equal(url.pathname, "/api/v3/athlete/activities");
    assert.equal(init.headers.Authorization, "Bearer test-access");
    assert.equal(Number(url.searchParams.get("before")) - Number(url.searchParams.get("after")), 90 * 86400);
    const body = getPage(Number(url.searchParams.get("page")));
    return body instanceof Response ? body : Response.json(body);
  });
}

test("sync payload is strict and carries only the persistent run ID", () => {
  assert.deepEqual(SyncAthleteJobSchema.parse({ jobRunId: 1 }), { jobRunId: 1 });
  assert.equal(SyncAthleteJobSchema.safeParse({ userId: 1 }).success, false);
  assert.equal(SyncAthleteJobSchema.safeParse({ jobRunId: 1, accessToken: "secret" }).success, false);
});

test("enqueue requires the session and correct origin; concurrent clicks share one job", async () => {
  assert.equal((await enqueue(request("POST", "invalid"))).status, 401);
  assert.equal((await enqueue(request("POST", session, "https://unrelated.example"))).status, 403);
  const responses = await Promise.all([enqueue(request()), enqueue(request("POST", session, origin, { userId: 99999 }))]);
  const ids = await Promise.all(responses.map(async response => {
    assert.equal(response.status, 202); return (await response.json()).jobRunId;
  }));
  assert.equal(ids[0], ids[1]);
  assert.equal(await queue.getWaitingCount(), 1);
  const job = await Job.fromId(queue, syncJobId(ids[0]));
  assert.deepEqual(job.data, { jobRunId: ids[0] });
  assert.equal((await prisma.jobRun.findUniqueOrThrow({ where: { id: ids[0] } })).userId, user.id);
});

test("queued worker paginates past short pages and stores swim, bike, run, and other activities", async () => {
  const provider = pages(page => page === 1 ? [activity(101), activity(102, "VirtualRide")] : page === 2 ? [activity(103, "Swim"), activity(104, "Walk")] : []);
  const { job, jobRunId } = await queued();
  await startWorker();
  assert.deepEqual(await job.waitUntilFinished(events, 15000), { activityCount: 4 });
  assert.equal(provider.mock.callCount(), 3);
  const saved = await prisma.activity.findMany({ orderBy: { stravaActivityId: "asc" } });
  assert.deepEqual(saved.map(value => value.type), ["RUN", "BIKE", "SWIM", "OTHER"]);
  assert.equal(saved[0].distanceMeters, 5000);
  assert.equal(saved[0].elevationMeters, 35);
  assert.equal(saved[0].durationSeconds, 1800);
  const run = await prisma.jobRun.findUniqueOrThrow({ where: { id: jobRunId } });
  assert.equal(run.status, "SUCCESS");
  assert.ok(run.finishedAt);
  assert.ok((await prisma.stravaConnection.findUniqueOrThrow({ where: { userId: user.id } })).lastSuccessfulSyncAt);
});

test("repeated sync updates existing activities instead of creating duplicates", async () => {
  let name = "Original name";
  pages(page => page === 1 ? [activity(101, "TrailRun", { name })] : []);
  let run = await queued();
  await startWorker();
  await run.job.waitUntilFinished(events, 15000);
  name = "Edited name";
  run = await queued();
  await run.job.waitUntilFinished(events, 15000);
  assert.equal(await prisma.activity.count(), 1);
  assert.equal((await prisma.activity.findFirstOrThrow()).name, "Edited name");
  assert.equal((await prisma.activity.findFirstOrThrow()).type, "RUN");
});

test("an empty activity history still records a successful sync", async () => {
  pages(() => []);
  const { job } = await queued();
  await startWorker();
  assert.deepEqual(await job.waitUntilFinished(events, 15000), { activityCount: 0 });
  const response = await status(request("GET"));
  const dashboard = await response.json();
  assert.equal(dashboard.latestSync.status, "SUCCESS");
  assert.ok(dashboard.lastSuccessfulSyncAt);
  assert.deepEqual(dashboard.activities, []);
});

test("a transient later-page failure retries with backoff and idempotently replays previous pages", async () => {
  let failed = false;
  pages(page => {
    if (page === 2 && !failed) { failed = true; return Response.json({}, { status: 500 }); }
    return page <= 2 ? [activity(100 + page)] : [];
  });
  const { job, jobRunId } = await queued();
  await startWorker();
  await job.waitUntilFinished(events, 15000);
  assert.equal((await Job.fromId(queue, job.id)).attemptsMade, 2);
  assert.equal(await prisma.activity.count(), 2);
  assert.equal((await prisma.jobRun.findUniqueOrThrow({ where: { id: jobRunId } })).activityCount, 2);
});

test("expired and rejected access tokens are refreshed and rotations persisted", async () => {
  let refreshCalls = 0;
  let rejected = false;
  mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(input);
    if (url.pathname === "/oauth/token") {
      refreshCalls++;
      assert.equal(init.body.get("refresh_token"), refreshCalls === 1 ? "test-refresh" : "rotated-refresh");
      return Response.json({ access_token: `rotated-${refreshCalls}`, refresh_token: "rotated-refresh", expires_at: Math.floor(future().getTime() / 1000) });
    }
    if (!rejected) { rejected = true; return Response.json({}, { status: 401 }); }
    assert.equal(init.headers.Authorization, "Bearer rotated-2");
    return Response.json(Number(url.searchParams.get("page")) === 1 ? [activity(101)] : []);
  });
  await prisma.stravaConnection.update({ where: { userId: user.id }, data: { expiresAt: new Date(0) } });
  const { job } = await queued();
  await startWorker();
  await job.waitUntilFinished(events, 15000);
  assert.equal(refreshCalls, 2);
  assert.equal((await prisma.stravaConnection.findUniqueOrThrow({ where: { userId: user.id } })).accessToken, "rotated-2");
});

test("permanent permission errors fail once and preserve the prior successful timestamp", async () => {
  const previous = new Date("2026-01-01T00:00:00Z");
  await prisma.stravaConnection.update({ where: { userId: user.id }, data: { lastSuccessfulSyncAt: previous } });
  pages(() => Response.json({ secret: "provider-secret" }, { status: 403 }));
  const { job, jobRunId } = await queued();
  await startWorker();
  await assert.rejects(job.waitUntilFinished(events, 15000), /reconnect/i);
  assert.equal((await Job.fromId(queue, job.id)).attemptsMade, 1);
  const run = await prisma.jobRun.findUniqueOrThrow({ where: { id: jobRunId } });
  assert.equal(run.status, "FAILED");
  assert.doesNotMatch(run.error, /provider-secret/);
  assert.equal((await prisma.stravaConnection.findUniqueOrThrow({ where: { userId: user.id } })).lastSuccessfulSyncAt.toISOString(), previous.toISOString());
});

test("rate limits delay the job and keep its Postgres status pending", async () => {
  pages(() => Response.json({}, { status: 429, headers: { "Retry-After": "120" } }));
  const { job, jobRunId } = await queued();
  worker = new Worker(QUEUES.jobs, processJob, { ...options, autorun: false, settings: { backoffStrategy: stravaBackoff } });
  const failed = once(worker, "failed");
  void worker.run();
  await failed;
  assert.equal(await job.getState(), "delayed");
  assert.ok((await Job.fromId(queue, job.id)).delay >= 120000);
  assert.equal((await prisma.jobRun.findUniqueOrThrow({ where: { id: jobRunId } })).status, "PENDING");
  const now = Date.parse("2026-09-04T12:01:00Z");
  assert.ok(stravaRateLimitDelay(new Headers({ "X-ReadRateLimit-Limit": "100,1000", "X-ReadRateLimit-Usage": "2,1000" }), now) > 11 * 3600000);
  assert.equal(stravaBackoff(1, "strava", new StravaApiError(429, 120000)), 120000);
});

test("malformed activities and wrong-athlete data cannot be persisted", async () => {
  pages(page => page === 1 ? [activity(101, "Run", { athlete: { id: 555 } })] : []);
  const { job } = await queued();
  await startWorker();
  await assert.rejects(job.waitUntilFinished(events, 15000), /different athlete/);
  assert.equal(await prisma.activity.count(), 0);
  pages(() => [activity(102, "Run", { moving_time: "invalid" })]);
  const another = await queued();
  await assert.rejects(another.job.waitUntilFinished(events, 15000), /invalid activity data/);
  assert.equal(await prisma.activity.count(), 0);
});

test("status returns only the signed-in user's activities and no credentials", async () => {
  assert.equal((await status(request("GET", "invalid"))).status, 401);
  const other = await prisma.user.create({ data: { name: "Other" } });
  await prisma.activity.create({ data: { userId: other.id, name: "Other private activity", type: "RUN", durationSeconds: 100, startedAt: new Date() } });
  const response = await status(request("GET"));
  const body = await response.text();
  assert.doesNotMatch(body, /Other private activity|test-access|test-refresh/);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("a missing persistent sync record is rejected without API access", async () => {
  const job = await queue.add(JOBS.syncAthlete, { jobRunId: 2147483647 }, { attempts: 5 });
  await startWorker();
  await assert.rejects(job.waitUntilFinished(events, 15000), /Sync record not found/);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("enqueue failure records a failed run and permits another attempt", async () => {
  const add = mock.method(getSyncQueue(), "add", async () => { throw new Error("Simulated enqueue failure"); });
  const response = await enqueue(request());
  assert.equal(response.status, 503);
  const failed = await prisma.jobRun.findFirstOrThrow();
  assert.equal(failed.status, "FAILED");
  add.mock.restore();
  const next = await queued();
  assert.notEqual(next.jobRunId, failed.id);
});

test("transient failures stop at the attempt limit and become a failed sync in Postgres", async () => {
  pages(() => Response.json({}, { status: 500 }));
  const run = await createOrReuseSyncRun(user.id);
  const job = await queue.add(JOBS.syncAthlete, { jobRunId: run.id }, {
    jobId: syncJobId(run.id), attempts: 2, backoff: { type: "strava" },
  });
  await startWorker();
  await assert.rejects(job.waitUntilFinished(events, 15000), /HTTP 500/);
  assert.equal((await Job.fromId(queue, job.id)).attemptsMade, 2);
  const saved = await prisma.jobRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(saved.status, "FAILED");
  assert.ok(saved.finishedAt);
  assert.equal((await prisma.stravaConnection.findUniqueOrThrow({ where: { userId: user.id } })).lastSuccessfulSyncAt, null);
});
