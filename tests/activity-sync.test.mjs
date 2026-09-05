import assert from "node:assert/strict";
import { once } from "node:events";
import { after, beforeEach, mock, test } from "node:test";
import { NextRequest } from "next/server.js";
import { Queue, QueueEvents, Worker, Job } from "bullmq";
import { prisma, createOrReuseSyncRun, startSyncRun, saveActivityPage, finishSyncRun, recordSyncFailure, renewSyncLease, SyncLeaseLostError } from "@pkg/db";
import { bullConnectionFromUrl, JOBS, QUEUES, syncJobId, SyncAthleteJobSchema } from "@pkg/shared";
import { StravaApiError, stravaRateLimitDelay } from "@pkg/shared/strava";
import { processJob, stravaBackoff } from "../apps/worker/dist/processor.js";
import { recoverMissingSyncJobs, startSyncRecovery } from "../apps/worker/dist/recovery.js";
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

test("enqueue failure retains the committed intent for automatic recovery", async () => {
  const add = mock.method(getSyncQueue(), "add", async () => { throw new Error("Simulated enqueue failure"); });
  const response = await enqueue(request());
  assert.equal(response.status, 202);
  assert.equal((await response.json()).recoveryPending, true);
  const pending = await prisma.jobRun.findFirstOrThrow();
  assert.equal(pending.status, "PENDING");
  add.mock.restore();
  await recoverMissingSyncJobs(queue);
  assert.ok(await queue.getJob(syncJobId(pending.id)));
  assert.equal((await queued()).jobRunId, pending.id);
});

test("concurrent recovery scans recreate one missing job and the worker completes it", async () => {
  pages(page => page === 1 ? [activity(101)] : []);
  const run = await createOrReuseSyncRun(user.id); // Simulate web crash before queue.add.
  await Promise.all([recoverMissingSyncJobs(queue), recoverMissingSyncJobs(queue)]);
  assert.equal(await queue.getWaitingCount(), 1);
  const job = await queue.getJob(syncJobId(run.id));
  assert.deepEqual(job.data, { jobRunId: run.id });
  await startWorker();
  await job.waitUntilFinished(events, 15000);
  const saved = await prisma.jobRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(saved.status, "SUCCESS");
  assert.equal(saved.attemptsStarted, 1);
  assert.equal(saved.leaseExpiresAt, null);
  assert.equal(await recoverMissingSyncJobs(queue), 0);
});

test("a lost enqueue acknowledgement cannot mark a successfully queued sync failed", async () => {
  const producer = getSyncQueue();
  const originalAdd = producer.add.bind(producer);
  mock.method(producer, "add", async (...args) => { await originalAdd(...args); throw new Error("Lost acknowledgement"); });
  const response = await enqueue(request());
  assert.equal(response.status, 202);
  const run = await prisma.jobRun.findFirstOrThrow();
  assert.equal(run.status, "PENDING");
  assert.equal(await recoverMissingSyncJobs(queue), 0);
  assert.equal(await queue.getWaitingCount(), 1);
});

test("recovery leaves queued, paused, delayed and active jobs alone", async () => {
  const waiting = await queued();
  assert.equal(await recoverMissingSyncJobs(queue), 0);
  await queue.pause();
  assert.equal(await recoverMissingSyncJobs(queue), 0);
  await queue.resume();
  await waiting.job.remove();
  const delayed = await queue.add(JOBS.syncAthlete, { jobRunId: waiting.jobRunId }, { jobId: syncJobId(waiting.jobRunId), delay: 60000 });
  assert.equal(await recoverMissingSyncJobs(queue), 0);
  assert.equal(await delayed.getState(), "delayed");
  await delayed.remove();
  await queue.add(JOBS.syncAthlete, { jobRunId: waiting.jobRunId }, { jobId: syncJobId(waiting.jobRunId) });
  worker = new Worker(QUEUES.jobs, processJob, { ...options, autorun: false });
  const activeJob = await worker.getNextJob("recovery-test-lock");
  assert.ok(activeJob);
  assert.equal(await activeJob.getState(), "active");
  assert.equal(await recoverMissingSyncJobs(queue), 0);
});

test("missing running jobs wait for lease expiry; recovered attempts replay pages idempotently", async () => {
  const run = await createOrReuseSyncRun(user.id);
  const first = await startSyncRun(run.id, 0);
  await saveActivityPage(run.id, user.id, [activity(101)], 1, first.attemptNumber);
  assert.equal(await recoverMissingSyncJobs(queue), 0);
  await prisma.jobRun.update({ where: { id: run.id }, data: { leaseExpiresAt: new Date(0) } });
  await recoverMissingSyncJobs(queue);
  pages(page => page === 1 ? [activity(101), activity(102)] : []);
  const job = await queue.getJob(syncJobId(run.id));
  await startWorker();
  await job.waitUntilFinished(events, 15000);
  assert.equal(await prisma.activity.count(), 2);
  const saved = await prisma.jobRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(saved.attemptsStarted, 2);
  assert.equal(saved.activityCount, 2);
});

test("recreated jobs preserve a persisted rate-limit delay and an early job cannot bypass it", async () => {
  const run = await createOrReuseSyncRun(user.id);
  const first = await startSyncRun(run.id, 0);
  const retryAt = new Date(Date.now() + 60000);
  await recordSyncFailure(run.id, first.attemptNumber, "Rate limited", retryAt);
  await recoverMissingSyncJobs(queue);
  const job = await queue.getJob(syncJobId(run.id));
  assert.equal(await job.getState(), "delayed");
  assert.ok(job.delay > 50000);
  // Simulate another producer losing the delay option. The processor checks PG too.
  await job.promote();
  await startWorker();
  for (let check = 0; check < 100 && await job.getState() !== "delayed"; check++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(await job.getState(), "delayed");
  assert.equal((await prisma.jobRun.findUniqueOrThrow({ where: { id: run.id } })).attemptsStarted, 1);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("repeated Redis job loss cannot reset the persisted five-attempt limit", async () => {
  const run = await createOrReuseSyncRun(user.id);
  for (let attemptNumber = 1; attemptNumber <= 5; attemptNumber++) {
    await recoverMissingSyncJobs(queue);
    const job = await queue.getJob(syncJobId(run.id));
    assert.ok(job);
    const claim = await startSyncRun(run.id, 0); // Each new Redis job starts at zero.
    assert.equal(claim.attemptNumber, attemptNumber);
    await job.remove();
    await prisma.jobRun.update({ where: { id: run.id }, data: { leaseExpiresAt: new Date(0) } });
  }
  await recoverMissingSyncJobs(queue);
  assert.equal(await queue.getJob(syncJobId(run.id)), undefined);
  const saved = await prisma.jobRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(saved.status, "FAILED");
  assert.equal(saved.attemptsStarted, 5);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("an expired processor cannot write pages, success or failure over a newer execution", async () => {
  const run = await createOrReuseSyncRun(user.id);
  const first = await startSyncRun(run.id, 0);
  assert.equal((await startSyncRun(run.id, 0)).kind, "deferred");
  await prisma.jobRun.update({ where: { id: run.id }, data: { leaseExpiresAt: new Date(0) } });
  const second = await startSyncRun(run.id, 0);
  assert.equal(second.attemptNumber, 2);
  await assert.rejects(renewSyncLease(run.id, first.attemptNumber), SyncLeaseLostError);
  await assert.rejects(saveActivityPage(run.id, user.id, [activity(101)], 1, first.attemptNumber), SyncLeaseLostError);
  await assert.rejects(finishSyncRun(run.id, user.id, first.attemptNumber), SyncLeaseLostError);
  await recordSyncFailure(run.id, first.attemptNumber, "Old attempt failed", null);
  assert.equal(await prisma.activity.count(), 0);
  assert.equal((await prisma.jobRun.findUniqueOrThrow({ where: { id: run.id } })).status, "RUNNING");
  assert.equal((await prisma.stravaConnection.findUniqueOrThrow({ where: { userId: user.id } })).lastSuccessfulSyncAt, null);
});

test("terminal database runs are never resurrected by recovery or a leftover queue job", async () => {
  for (const status of ["SUCCESS", "FAILED", "CANCELLED"]) {
    const run = await prisma.jobRun.create({ data: { userId: user.id, status } });
    assert.equal(await recoverMissingSyncJobs(queue), 0);
    assert.equal((await startSyncRun(run.id, 0)).kind, "terminal");
  }
  assert.equal(await queue.getWaitingCount(), 0);
});

test("terminal BullMQ failure is reconciled when a processor could not update Postgres", async () => {
  const run = await createOrReuseSyncRun(user.id);
  const job = await queue.add(JOBS.syncAthlete, { jobRunId: run.id }, { jobId: syncJobId(run.id), attempts: 1 });
  worker = new Worker(QUEUES.jobs, async () => { throw new Error("Simulated crash"); }, options);
  await assert.rejects(job.waitUntilFinished(events, 15000), /Simulated crash/);
  await recoverMissingSyncJobs(queue);
  assert.equal((await prisma.jobRun.findUniqueOrThrow({ where: { id: run.id } })).status, "FAILED");
  assert.equal(await job.getState(), "failed");
});

test("the recovery service scans on startup and periodically, then stops cleanly", async () => {
  const run = await createOrReuseSyncRun(user.id);
  const stopRecovery = startSyncRecovery(30);
  try {
    for (let check = 0; check < 100 && !await queue.getJob(syncJobId(run.id)); check++) await new Promise(resolve => setTimeout(resolve, 10));
    const job = await queue.getJob(syncJobId(run.id));
    assert.ok(job);
    await job.remove();
    for (let check = 0; check < 100 && !await queue.getJob(syncJobId(run.id)); check++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(await queue.getJob(syncJobId(run.id)));
  } finally { await stopRecovery(); }
});

test("the recovery service reconnects after Redis is unavailable at startup", async () => {
  const run = await createOrReuseSyncRun(user.id);
  const originalRedisUrl = process.env.REDIS_URL;
  process.env.REDIS_URL = "redis://127.0.0.1:1";
  const stopRecovery = startSyncRecovery(30);
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal((await prisma.jobRun.findUniqueOrThrow({ where: { id: run.id } })).status, "PENDING");
    process.env.REDIS_URL = originalRedisUrl;
    for (let check = 0; check < 600 && !await queue.getJob(syncJobId(run.id)); check++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(await queue.getJob(syncJobId(run.id)));
  } finally {
    process.env.REDIS_URL = originalRedisUrl;
    await stopRecovery();
  }
});

test("a recovered final attempt fails once instead of consuming a new BullMQ retry budget", async () => {
  const run = await createOrReuseSyncRun(user.id);
  await prisma.jobRun.update({ where: { id: run.id }, data: { attemptsStarted: 4 } });
  pages(() => Response.json({}, { status: 500 }));
  await recoverMissingSyncJobs(queue);
  const job = await queue.getJob(syncJobId(run.id));
  await startWorker();
  await assert.rejects(job.waitUntilFinished(events, 15000), /Sync failed/);
  assert.equal((await queue.getJob(job.id)).attemptsMade, 1);
  assert.equal((await prisma.jobRun.findUniqueOrThrow({ where: { id: run.id } })).attemptsStarted, 5);
  assert.equal((await prisma.jobRun.findUniqueOrThrow({ where: { id: run.id } })).status, "FAILED");
});

test("an exhausted rate-limited sync does not promise another automatic retry", async () => {
  const syncRun = await createOrReuseSyncRun(user.id);
  await prisma.jobRun.update({ where: { id: syncRun.id }, data: { attemptsStarted: 4 } });
  const providerRequests = pages(() => Response.json({}, { status: 429 }));

  await assert.rejects(processJob({
    name: JOBS.syncAthlete, data: { jobRunId: syncRun.id }, attemptsMade: 0, opts: { attempts: 5 },
  }), /Strava's request limit was reached\. Please try syncing again later\./);

  const savedSync = await prisma.jobRun.findUniqueOrThrow({ where: { id: syncRun.id } });
  assert.equal(savedSync.status, "FAILED");
  assert.equal(savedSync.attemptsStarted, 5);
  assert.equal(savedSync.nextRetryAt, null);
  assert.doesNotMatch(savedSync.error, /Waiting before retrying/);
  assert.equal(providerRequests.mock.callCount(), 1);
});

test("a Redis lookup failure does not imply a missing job or alter Postgres status", async () => {
  const run = await createOrReuseSyncRun(user.id);
  mock.method(queue, "getJob", async () => { throw new Error("Redis unavailable"); });
  const add = mock.method(queue, "add");
  await assert.rejects(recoverMissingSyncJobs(queue), /Redis unavailable/);
  assert.equal(add.mock.callCount(), 0);
  assert.equal((await prisma.jobRun.findUniqueOrThrow({ where: { id: run.id } })).status, "PENDING");
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
