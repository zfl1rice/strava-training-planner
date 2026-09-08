import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import { Queue, QueueEvents, Worker } from "bullmq";
import { NextRequest } from "next/server.js";
import { readFileSync } from "node:fs";
import {
  prisma, saveWeeklyGoals, createInitialTrainingBlock, createOrReuseReviewRun, executeReviewRun,
  generateAndSaveFlexiblePlan, getTrainingBlockState, createOrReusePlanRun, createOrReuseSyncRun,
  buildPlanningContext, createRaceGoal,
} from "@pkg/db";
import { calendarMonday, easyWorkout, bullConnectionFromUrl, QUEUES, JOBS, reviewJobId, validateStoredPlan, DevelopmentBlockSchema, PlanProviderError } from "@pkg/shared";
import { configuredBlockReviewer } from "../apps/worker/src/review-provider.ts";
import { processJob } from "../apps/worker/src/processor.ts";
import { recoverMissingPlanJobs } from "../apps/worker/src/plan-recovery.ts";
import { POST, GET } from "../apps/web/src/app/api/training-block/route.ts";
import { POST as generate, GET as generationStatus } from "../apps/web/src/app/api/planner/route.ts";
import { GET as calendar } from "../apps/web/src/app/api/calendar/route.ts";
import { PATCH as feedback } from "../apps/web/src/app/api/workout-feedback/route.ts";
import { newOpaqueToken, hashToken } from "../apps/web/src/lib/strava-auth.ts";
import { getPlanQueue } from "../apps/web/src/lib/queue.ts";

assert.match(process.env.OAUTH_TEST_DATABASE ?? "", /^planner_oauth_test_[a-f0-9]{16}$/);
assert.equal(new URL(process.env.DATABASE_URL).pathname, `/${process.env.OAUTH_TEST_DATABASE}`);
assert.equal(process.env.BULLMQ_PREFIX, process.env.OAUTH_TEST_DATABASE);
const queueOptions = { prefix: process.env.BULLMQ_PREFIX, connection: bullConnectionFromUrl(process.env.REDIS_URL) };
const queue = new Queue(QUEUES.jobs, queueOptions);
const events = new QueueEvents(QUEUES.jobs, queueOptions);
await events.waitUntilReady();
let user, block, session, worker;
const weekStart = calendarMonday(new Date().toISOString().slice(0, 10));
const proposal = context => ({ decision: "HOLD", rationale: "Reported evidence is incomplete; preserve the useful strategy without claiming verified execution.", focusGuidance: context.block.focuses.map(focus => ({ focusId: `${focus.sport}:${focus.capability}`, action: focus.role === "MAINTENANCE" ? "MAINTAIN" : "HOLD", rationale: "Keep the current emphasis while gathering feedback." })) });
const reviewer = { source: "SIMULATED", review: async context => proposal(context) };
const request = (body, path = "/api/training-block", origin = "http://localhost:3000") => new NextRequest(`http://localhost:3000${path}`, {
  method: body ? "POST" : "GET", headers: { origin, cookie: `planner_session=${session}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
});
const reviewRequest = () => ({ blockId: block.id, revision: block.revision, weekStart });
beforeEach(async () => {
  if (worker) { await worker.close(); worker = undefined; }
  mock.restoreAll(); process.env.PLANNER_PROVIDER = "deterministic"; process.env.OPENAI_API_KEY = "";
  await queue.obliterate({ force: true });
  await prisma.activity.deleteMany(); await prisma.jobRun.deleteMany(); await prisma.user.deleteMany();
  user = await prisma.user.create({ data: {} });
  session = newOpaqueToken();
  await prisma.session.create({ data: { tokenHash: hashToken(session), userId: user.id, expiresAt: new Date(Date.now() + 3600000) } });
  await saveWeeklyGoals(user.id, { RUN: 120, BIKE: 240, SWIM: 60 });
  block = await createInitialTrainingBlock(user.id);
  await generateAndSaveFlexiblePlan(user.id, new Date(`${weekStart}T12:00:00Z`), "REMAINING_WEEK");
});
after(async () => {
  mock.restoreAll(); if (worker) await worker.close();
  await getPlanQueue().close(); await queue.obliterate({ force: true }); await events.close(); await queue.close(); await prisma.$disconnect();
});

test("initial general-fitness block is reused and real weekly context contains its strategy", async () => {
  assert.equal((await createInitialTrainingBlock(user.id)).id, block.id);
  const context = await buildPlanningContext(user.id);
  assert.equal(context.developmentBlock.id, block.id);
});

test("race-targeted starter follows stored short-event demands and actual race week", async () => {
  await createRaceGoal(user.id, { name: "Short run", eventType: "800m", sports: ["RUN"], date: weekStart, importance: 100, distanceMeters: 800, expectedDurationSeconds: 120, performanceGoal: null, demandProfile: null });
  const replacement = await createInitialTrainingBlock(user.id, true, new Date(`${weekStart}T12:00:00Z`));
  assert.equal(replacement.proposal.focuses[0].capability, "SPEED");
  assert.equal(replacement.proposal.weekPattern[0], "RACE");
  assert.equal(replacement.proposal.raceIds.length, 1);
});

test("review request deduplicates and prevents overlapping sync or generation", async () => {
  const first = await createOrReuseReviewRun(user.id, reviewRequest());
  assert.equal((await createOrReuseReviewRun(user.id, reviewRequest())).id, first.id);
  await assert.rejects(createOrReusePlanRun(user.id, { scope: "NEXT_WEEK" }), /review/);
  await assert.rejects(createOrReuseSyncRun(user.id), /review/);
  await assert.rejects(createInitialTrainingBlock(user.id, true), /finish/);
});

test("review persistence is atomic, replay does not append twice, and guidance reaches next context", async () => {
  const run = await createOrReuseReviewRun(user.id, reviewRequest());
  assert.equal((await executeReviewRun(run.id, reviewer)).status, "SUCCESS");
  assert.equal((await executeReviewRun(run.id, reviewer)).status, "SUCCESS");
  const state = await getTrainingBlockState(user.id);
  assert.equal(state.block.reviews.length, 1);
  assert.equal(state.review.status, "SUCCESS");
  assert.equal((await buildPlanningContext(user.id)).developmentBlock.previousReview.request.decision, "HOLD");
});

test("fractional recorded durations survive persisted review snapshots", async () => {
  await prisma.activity.create({ data: { userId: user.id, type: "RUN", source: "MANUAL",
    startedAt: new Date(Date.now() - 8 * 86400000), durationSeconds: 1234, distanceMeters: 3210 } });
  const run = await createOrReuseReviewRun(user.id, reviewRequest());
  assert.equal((await executeReviewRun(run.id, reviewer)).status, "SUCCESS");
});

test("settings changed during review cancel the result and preserve prior block and plan", async () => {
  const before = await prisma.weeklyPlan.findMany({ where: { userId: user.id } });
  const run = await createOrReuseReviewRun(user.id, reviewRequest());
  const result = await executeReviewRun(run.id, { source: "SIMULATED", review: async context => { await saveWeeklyGoals(user.id, { RUN: 100, BIKE: 240, SWIM: 60 }); return proposal(context); } });
  assert.equal(result.status, "CANCELLED");
  assert.equal((await getTrainingBlockState(user.id)).block.revision, 1);
  assert.deepEqual(await prisma.weeklyPlan.findMany({ where: { userId: user.id } }), before);
});

test("lost review lease cannot publish or overwrite a new owner", async () => {
  const run = await createOrReuseReviewRun(user.id, reviewRequest());
  await executeReviewRun(run.id, { source: "SIMULATED", review: async context => {
    await prisma.jobRun.update({ where: { id: run.id }, data: { attemptsStarted: 2 } }); return proposal(context);
  } });
  assert.equal((await getTrainingBlockState(user.id)).block.revision, 1);
  assert.equal((await prisma.jobRun.findUnique({ where: { id: run.id } })).status, "RUNNING");
});

test("missing OpenAI configuration fails usefully without a provider call or changing plans", async () => {
  const run = await createOrReuseReviewRun(user.id, reviewRequest());
  assert.equal((await executeReviewRun(run.id, configuredBlockReviewer())).status, "FAILED");
  assert.match((await getTrainingBlockState(user.id)).review.error, /PLANNER_PROVIDER=openai/);
});

test("transient review failure persists backoff and succeeds on the next infrastructure attempt", async () => {
  const run = await createOrReuseReviewRun(user.id, reviewRequest());
  await assert.rejects(executeReviewRun(run.id, { source: "SIMULATED", review: async () => { throw new PlanProviderError("TRANSIENT", "Temporary provider failure", true, 5000); } }), /retrying/);
  assert.equal((await executeReviewRun(run.id, reviewer)).status, "DEFERRED");
  await prisma.jobRun.update({ where: { id: run.id }, data: { nextRetryAt: new Date(0) } });
  assert.equal((await executeReviewRun(run.id, reviewer)).status, "SUCCESS");
  assert.equal((await prisma.jobRun.findUnique({ where: { id: run.id } })).attemptsStarted, 2);
});

test("invalid review proposals stop after three corrections and preserve the block", async () => {
  const run = await createOrReuseReviewRun(user.id, reviewRequest());
  let calls = 0;
  const result = await executeReviewRun(run.id, { source: "SIMULATED", review: async () => { calls++; return { decision: "INVENTED" }; } });
  assert.equal(result.status, "FAILED"); assert.equal(calls, 3);
  assert.equal((await getTrainingBlockState(user.id)).block.revision, 1);
});

test("queued review uses frozen evidence and rejects edits before calling the provider", async () => {
  const run = await createOrReuseReviewRun(user.id, reviewRequest());
  await saveWeeklyGoals(user.id, { RUN: 0, BIKE: 240, SWIM: 60 });
  assert.equal((await executeReviewRun(run.id, { source: "SIMULATED", review: async () => assert.fail("Stale request must not call provider") })).status, "CANCELLED");
});

test("HTTP review rejects absent session, wrong origin, unowned blocks and malformed dates", async () => {
  assert.equal((await GET(new NextRequest("http://localhost:3000/api/training-block"))).status, 401);
  assert.equal((await POST(request({ action: "REVIEW", request: reviewRequest() }, undefined, "https://untrusted.example"))).status, 403);
  assert.equal((await POST(request({ action: "REVIEW", request: { ...reviewRequest(), blockId: block.id + 1 } }))).status, 400);
  assert.equal((await POST(request({ action: "REVIEW", request: { ...reviewRequest(), weekStart: "invalid" } }))).status, 400);
});

test("recovery dispatches a persisted review missing from Redis", async () => {
  const run = await createOrReuseReviewRun(user.id, reviewRequest());
  await recoverMissingPlanJobs(queue, "REVIEW_BLOCK");
  const job = await queue.getJob(reviewJobId(run.id));
  assert.equal(job.name, JOBS.reviewBlock);
  assert.deepEqual(job.data, { jobRunId: run.id });
});

test("browser endpoints through real BullMQ worker and mocked OpenAI persist weekly plans and reviews", async () => {
  await prisma.activity.create({ data: { userId: user.id, type: "RUN", source: "MANUAL",
    startedAt: new Date(Date.now() - 8 * 86400000), durationSeconds: 1234, distanceMeters: 3210 } });
  process.env.PLANNER_PROVIDER = "openai"; process.env.OPENAI_API_KEY = "fake-test-key";
  let calls = 0;
  mock.method(globalThis, "fetch", async (url, init) => {
    assert.match(String(url), /^https:\/\/api.openai.com\//);
    calls++;
    const body = JSON.parse(init.body);
    const input = JSON.parse(body.input[0].content);
    const value = input.review ? proposal(input.review) : { version: 1, explanation: "Mocked integration plan.", workouts: [easyWorkout("mock-run", input.planning.targetWeek.startDate, "RUN", calls === 1 ? 30 : 35)] };
    return new Response(JSON.stringify({ id: `resp_mock_${calls}`, object: "response", status: "completed", model: "test-model", output: [{ type: "message", role: "assistant", id: "msg_test", status: "completed", content: [{ type: "output_text", text: JSON.stringify(value), annotations: [] }] }], usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } }), { headers: { "content-type": "application/json" } });
  });
  worker = new Worker(QUEUES.jobs, processJob, queueOptions);
  const queued = await generate(request({ scope: "NEXT_WEEK" }, "/api/planner"));
  assert.equal(queued.status, 202);
  const planState = await queued.json();
  const planJob = await queue.getJob(`plan-${planState.generation.id}`);
  await planJob.waitUntilFinished(events, 15000);
  const generated = await (await generationStatus(request(undefined, "/api/planner"))).json();
  assert.equal(generated.generation.status, "SUCCESS");
  assert.equal(generated.nextPlan.content.generation.provider, "openai");
  const replacement = await generate(request({ scope: "NEXT_WEEK" }, "/api/planner"));
  assert.equal(replacement.status, 202);
  const replacementState = await replacement.json();
  assert.notEqual(replacementState.generation.id, planState.generation.id);
  await (await queue.getJob(`plan-${replacementState.generation.id}`)).waitUntilFinished(events, 15000);
  const regenerated = await (await generationStatus(request(undefined, "/api/planner"))).json();
  assert.equal(regenerated.generation.status, "SUCCESS");
  assert.equal(regenerated.nextPlan.id, generated.nextPlan.id);
  assert.equal(regenerated.nextPlan.content.totalMinutes, 35);
  const month = generated.nextPlan.content.weekStart.slice(0, 7);
  const view = await (await calendar(request(undefined, `/api/calendar?month=${month}`))).json();
  assert.ok(view.plans.some(plan => plan.id === generated.nextPlan.id));
  assert.equal(view.plans.find(plan => plan.id === generated.nextPlan.id).content.totalMinutes, 35);
  const current = await prisma.weeklyPlan.findFirst({ where: { userId: user.id, weekStart: new Date(`${weekStart}T00:00:00Z`) } });
  const workout = current.content.days.find(day => day.kind === "WORKOUT");
  const savedFeedback = await feedback(new NextRequest("http://localhost:3000/api/workout-feedback", { method: "PATCH", headers: { origin: "http://localhost:3000", cookie: `planner_session=${session}`, "content-type": "application/json" },
    body: JSON.stringify({ planId: current.id, workoutId: workout.id, expectedUpdatedAt: current.updatedAt.toISOString(), completion: "COMPLETED", locked: false, rpe: 4, comment: "Comfortable reported effort." }) }));
  assert.equal(savedFeedback.status, 200);
  const response = await POST(request({ action: "REVIEW", request: reviewRequest() }));
  assert.equal(response.status, 202);
  const body = await response.json();
  await (await queue.getJob(reviewJobId(body.review.id))).waitUntilFinished(events, 15000);
  const reviewed = await (await GET(request())).json();
  assert.equal(reviewed.review.status, "SUCCESS");
  assert.equal(reviewed.block.reviews[0].source.provider, "OPENAI");
  assert.equal(reviewed.block.reviews[0].evidence.workouts.find(item => item.id === workout.id).feedback.rpe, 4);
  assert.equal(calls, 3);
});

test("public demo contains schema-valid synthetic workouts and review, without tokens or Strava IDs", () => {
  const sample = JSON.parse(readFileSync(new URL("../apps/web/src/app/demo/sample.json", import.meta.url), "utf8"));
  sample.calendar.plans.forEach(plan => validateStoredPlan(plan.content));
  DevelopmentBlockSchema.parse(sample.block.block);
  assert.ok(sample.calendar.activities.every(activity => activity.stravaActivityId === null));
  assert.doesNotMatch(JSON.stringify(sample), /accessToken|refreshToken|apiKey|OPENAI_API_KEY/);
});
