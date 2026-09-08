import { planningSnapshotsEqual } from "./planning-snapshots.js";
import type { Prisma } from "@prisma/client";
import {
  StoredReviewJobSchema as RequestSchema, ReviewWeekRequestSchema, ProviderCallMetadataSchema, type StoredReviewJob,
  generateBlockReview, blockReviewRequest, localDateAt, PlanProviderError, ProposalAttemptsExhaustedError,
  PLAN_ATTEMPTS, PLAN_LEASE_MS, PLAN_HEARTBEAT_MS, type BlockReviewer, type ProviderCallMetadata,
} from "@pkg/shared";
import { prisma } from "./client.js";
import { lockUserTraining } from "./training-lock.js";
import { buildBlockReviewContext } from "./block-reviews.js";
import { recordBlockReview, StaleBlockGenerationError } from "./development-blocks.js";
import { TrainingBusyError } from "./plan-jobs.js";


export async function createOrReuseReviewRun(userId: number, raw: unknown, now = new Date()) {
  const request = ReviewWeekRequestSchema.parse(raw);
  return prisma.$transaction(async database => {
    await lockUserTraining(database, userId);
    const pending = await database.jobRun.findFirst({ where: { userId, status: { in: ["PENDING", "RUNNING"] } } });
    if (pending?.jobType === "REVIEW_BLOCK") {
      const saved = RequestSchema.parse(pending.reviewRequest).snapshot;
      if (saved.block.id === request.blockId && saved.block.revision === request.revision && saved.evidence.weekStart === request.weekStart) return pending;
    }
    if (pending) throw new TrainingBusyError("Wait for sync, generation, or review to finish.");
    const snapshot = await buildBlockReviewContext(userId, request.blockId, request.weekStart, now, database);
    if (snapshot.block.revision !== request.revision) throw new StaleBlockGenerationError();
    if (!snapshot.evidence.plan) throw new TrainingBusyError("Generate a plan for this week before reviewing it.");
    return database.jobRun.create({ data: { userId, jobType: "REVIEW_BLOCK", reviewRequest: { snapshot, execution: { calls: [], proposals: [] } } } });
  }, { timeout: 15000 });
}

async function currentReview(database: Prisma.TransactionClient, id: number, attempt: number, now: Date) {
  const row = await database.jobRun.findUniqueOrThrow({ where: { id } });
  if (row.jobType !== "REVIEW_BLOCK" || row.status !== "RUNNING" || row.attemptsStarted !== attempt || !row.leaseExpiresAt || row.leaseExpiresAt.getTime() <= Date.now()) throw new StaleBlockGenerationError();
  const request = RequestSchema.parse(row.reviewRequest);
  const snapshot = request.snapshot;
  let current;
  try { current = await buildBlockReviewContext(row.userId, snapshot.block.id, snapshot.evidence.weekStart, new Date(snapshot.evidence.generatedAt), database); }
  catch { throw new StaleBlockGenerationError(); }
  if (snapshot.athleteId !== row.userId || !planningSnapshotsEqual(current, snapshot) || localDateAt(now, snapshot.evidence.timeZone) !== localDateAt(new Date(snapshot.evidence.generatedAt), snapshot.evidence.timeZone)) throw new StaleBlockGenerationError();
  return { row, request };
}

/** Persistent dispatch is the only application entry point for live review. */
export async function executeReviewRun(id: number, reviewer: BlockReviewer, options: { now?: Date; heartbeatIntervalMs?: number } = {}) {
  const row = await prisma.jobRun.findUniqueOrThrow({ where: { id } });
  if (row.jobType !== "REVIEW_BLOCK") throw new Error("Review request not found");
  const now = () => options.now ?? new Date();
  const claim = await prisma.$transaction(async database => {
    await lockUserTraining(database, row.userId);
    const current = await database.jobRun.findUniqueOrThrow({ where: { id } });
    if (!["PENDING", "RUNNING"].includes(current.status)) return { terminal: current.status };
    const until = Math.max(current.leaseExpiresAt?.getTime() ?? 0, current.nextRetryAt?.getTime() ?? 0);
    if (until > Date.now()) return { until };
    if (current.attemptsStarted >= PLAN_ATTEMPTS) {
      await database.jobRun.update({ where: { id }, data: { status: "FAILED", error: "Review attempt limit reached. Request review again.", finishedAt: new Date(), leaseExpiresAt: null } });
      return { terminal: "FAILED" };
    }
    const attempt = current.attemptsStarted + 1;
    await database.jobRun.update({ where: { id }, data: { status: "RUNNING", attemptsStarted: attempt, startedAt: new Date(), error: null, nextRetryAt: null, leaseExpiresAt: new Date(Date.now() + PLAN_LEASE_MS) } });
    return { attempt };
  });
  if ("terminal" in claim) return { status: claim.terminal };
  if ("until" in claim) return { status: "DEFERRED", until: claim.until };
  const attempt = claim.attempt!;
  const cancellation = new AbortController();
  let heartbeat: Promise<void> | undefined;
  const owned = async <T>(fn: (database: Prisma.TransactionClient, request: StoredReviewJob) => Promise<T>) => prisma.$transaction(async database => {
    await lockUserTraining(database, row.userId);
    const { request } = await currentReview(database, id, attempt, now());
    return fn(database, request);
  }, { timeout: 15000 });
  const timer = setInterval(() => {
    if (heartbeat) return;
    heartbeat = owned(async database => { await database.jobRun.update({ where: { id }, data: { leaseExpiresAt: new Date(Date.now() + PLAN_LEASE_MS) } }); })
      .catch(error => { cancellation.abort(error); }).finally(() => { heartbeat = undefined; });
  }, options.heartbeatIntervalMs ?? PLAN_HEARTBEAT_MS);
  try {
    const snapshot = await owned(async (_database, request) => request.snapshot);
    const reportCall = async (call: ProviderCallMetadata) => {
      const metadata = ProviderCallMetadataSchema.parse({ ...call, infrastructureAttempt: attempt });
      console.info(JSON.stringify({ event: "block_review.provider_call", jobRunId: id, ...metadata }));
      await owned(async (database, request) => {
        request.execution.calls.push(metadata);
        await database.jobRun.update({ where: { id }, data: { reviewRequest: RequestSchema.parse(request) } });
      });
    };
    const persistent: BlockReviewer = { source: reviewer.source, review: async (context, correction) => {
      const cached = await owned(async (_database, request) => request.execution.proposals.find(value => value.attempt === correction.attempt));
      if (cached) return JSON.parse(cached.json);
      const value = await reviewer.review(context, correction);
      correction.signal?.throwIfAborted();
      await owned(async (database, request) => {
        request.execution.proposals.push({ attempt: correction.attempt, json: JSON.stringify(value) });
        await database.jobRun.update({ where: { id }, data: { reviewRequest: RequestSchema.parse(request) } });
      });
      return value;
    } };
    const proposal = await generateBlockReview(snapshot, persistent, { signal: cancellation.signal, reportCall });
    return await owned(async (database, request) => {
      const last = request.execution.calls.filter(call => call.category === "RESPONSE").at(-1);
      await recordBlockReview(row.userId, snapshot.block.id, snapshot.block.revision, blockReviewRequest(snapshot, proposal), new Date(snapshot.evidence.generatedAt), {
        database, evidence: snapshot.evidence, source: { provider: reviewer.source, version: "block-review-v3", model: last?.model ?? null, responseId: last?.responseId ?? null },
      });
      await database.jobRun.update({ where: { id }, data: { status: "SUCCESS", finishedAt: new Date(), leaseExpiresAt: null, nextRetryAt: null, error: null } });
      return { status: "SUCCESS" };
    });
  } catch (error) {
    const stale = error instanceof StaleBlockGenerationError;
    const retry = !stale && !(error instanceof ProposalAttemptsExhaustedError) && (!(error instanceof PlanProviderError) || error.retryable) && attempt < PLAN_ATTEMPTS;
    const status = stale ? "CANCELLED" : retry ? "PENDING" : "FAILED";
    await prisma.jobRun.updateMany({ where: { id, status: "RUNNING", attemptsStarted: attempt }, data: {
      status, leaseExpiresAt: null, finishedAt: retry ? null : new Date(),
      nextRetryAt: retry ? new Date(Date.now() + Math.max(2000 * 2 ** (attempt - 1), error instanceof PlanProviderError ? error.retryAfterMs : 0)) : null,
      error: stale ? "Training inputs changed. Request review again; the previous block and plan were kept." : error instanceof PlanProviderError && !retry ? error.message
        : retry ? "Review interrupted; retrying automatically." : "Review could not complete. Check worker configuration and request review again. Previous results were kept.",
    } });
    if (retry) throw new Error("Review interrupted; retrying");
    return { status };
  } finally { clearInterval(timer); await heartbeat; }
}
