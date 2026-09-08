import { ProviderExecutionSchema, ProviderCallMetadataSchema, PlanProviderError, PLAN_HEARTBEAT_MS, PLAN_LEASE_MS, deterministicPlanProvider, type ProviderCallMetadata, GenerationInputSchema, generatePlanWithCorrections, ProposalAttemptsExhaustedError, type PlanProvider, GenerationRequestSchema, LocalDateSchema, PLAN_ATTEMPTS, addCalendarDays, calendarMonday, localDateAt } from "@pkg/shared";
import { prisma } from "./client.js";
import type { JobStatus } from "@prisma/client";
import { lockUserTraining } from "./training-lock.js";
import { prepareGenerationInput, generationInputIsCurrent, saveGeneratedPlan, StaleGenerationError, PlanSyncInProgressError } from "./planner.js";
const StoredRequestSchema = GenerationRequestSchema.extend({ weekStart: LocalDateSchema, snapshot: GenerationInputSchema.optional(), providerExecution: ProviderExecutionSchema.optional() });

export class TrainingBusyError extends Error {}

export async function createOrReusePlanRun(userId: number, input: unknown, now = new Date()) {
  const request = GenerationRequestSchema.parse(input);
  return prisma.$transaction(async database => {
    await lockUserTraining(database, userId);
    if (await database.jobRun.findFirst({ where: { userId, jobType: "REVIEW_BLOCK", status: { in: ["PENDING", "RUNNING"] } } })) throw new TrainingBusyError("Wait for block review to finish before generating a plan.");
    if (await database.jobRun.findFirst({ where: { userId, jobType: "STRAVA_SYNC", status: { in: ["PENDING", "RUNNING"] } } })) throw new TrainingBusyError("Wait for activity sync to finish before generating a plan.");
    const existing = await database.jobRun.findFirst({ where: { userId, jobType: "COMPUTE_PLAN", status: { in: ["PENDING", "RUNNING"] } } });
    const user = await database.user.findUniqueOrThrow({ where: { id: userId } });
    const weekStart = addCalendarDays(calendarMonday(localDateAt(now, user.timeZone)), request.scope === "NEXT_WEEK" ? 7 : 0);
    if (existing) {
      const pending = StoredRequestSchema.parse(existing.planRequest);
      if (pending.scope !== request.scope || pending.weekStart !== weekStart) throw new TrainingBusyError("A different generation request is already pending. Wait for it to finish.");
      if (!pending.snapshot || await generationInputIsCurrent(pending.snapshot, database, now)) return existing;
      await database.jobRun.update({ where: { id: existing.id }, data: { status: "CANCELLED", error: "Superseded after planning inputs changed", finishedAt: now, leaseExpiresAt: null, nextRetryAt: null } });
    }
    return database.jobRun.create({ data: { userId, jobType: "COMPUTE_PLAN", planRequest: { ...request, weekStart }, createdAt: now } });
  });
}

export async function executePlanRun(id: number, provider?: PlanProvider, options: { heartbeatIntervalMs?: number } = {}): Promise<{
  status: JobStatus | "DEFERRED"; error?: string | null; until?: number;
}> {
  const row = await prisma.jobRun.findUnique({ where: { id } });
  if (!row || row.jobType !== "COMPUTE_PLAN") throw new Error("Plan request not found");
  const claim = await prisma.$transaction(async database => {
    await lockUserTraining(database, row.userId);
    const current = await database.jobRun.findUniqueOrThrow({ where: { id } });
    if (!["PENDING", "RUNNING"].includes(current.status)) return { terminal: current.status, error: current.error };
    if ((current.leaseExpiresAt?.getTime() ?? 0) > Date.now() || (current.nextRetryAt?.getTime() ?? 0) > Date.now()) return { deferred: Math.max(current.leaseExpiresAt?.getTime() ?? 0, current.nextRetryAt?.getTime() ?? 0) };
    if (current.attemptsStarted >= PLAN_ATTEMPTS) {
      await database.jobRun.update({ where: { id }, data: { status: "FAILED", error: "Generation attempt limit reached. Request generation again.", finishedAt: new Date(), leaseExpiresAt: null } });
      return { terminal: "FAILED" as const, error: "Generation attempt limit reached. Request generation again." };
    }
    const attempt = current.attemptsStarted + 1;
    await database.jobRun.update({ where: { id }, data: { status: "RUNNING", attemptsStarted: attempt,
      startedAt: new Date(), error: null, nextRetryAt: null, leaseExpiresAt: new Date(Date.now() + PLAN_LEASE_MS) } });
    return { attempt };
  });
  if (claim.terminal !== undefined) return { status: claim.terminal, error: claim.error };
  if ("deferred" in claim) return { status: "DEFERRED", until: claim.deferred };
  const cancellation = new AbortController();
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeat: Promise<void> | undefined;
  try {
    const input = await prisma.$transaction(async database => {
      await lockUserTraining(database, row.userId);
      const current = await database.jobRun.findUniqueOrThrow({ where: { id } });
      if (current.status !== "RUNNING" || current.attemptsStarted !== claim.attempt) throw new StaleGenerationError();
      const request = StoredRequestSchema.parse(current.planRequest);
      const snapshot = request.snapshot ?? await prepareGenerationInput(row.userId, new Date(), request.weekStart, database);
      if (snapshot.context.athlete.id !== row.userId || snapshot.context.targetWeek.startDate !== request.weekStart) throw new StaleGenerationError();
      if (!await generationInputIsCurrent(snapshot, database)) throw new StaleGenerationError();
      if (!request.snapshot) await database.jobRun.update({ where: { id }, data: { planRequest: { ...request, snapshot } } });
      return snapshot;
    }, { timeout: 15000 });
    heartbeatTimer = setInterval(() => {
      if (heartbeat) return;
      heartbeat = renewPlanRunLease(id, claim.attempt!).catch(error => { cancellation.abort(error); })
        .finally(() => { heartbeat = undefined; });
    }, options.heartbeatIntervalMs ?? PLAN_HEARTBEAT_MS);
    const recorded = await prisma.jobRun.findUniqueOrThrow({ where: { id }, select: { planRequest: true } });
    const execution = StoredRequestSchema.parse(recorded.planRequest).providerExecution ?? { calls: [], proposals: [] };
    const persistentProvider: PlanProvider = async (snapshot, correction) => {
      await renewPlanRunLease(id, claim.attempt!);
      correction.signal?.throwIfAborted();
      const cached = execution.proposals.find(proposal => proposal.attempt === correction.attempt);
      if (cached) return JSON.parse(cached.json);
      const response = await (provider ?? deterministicPlanProvider)(snapshot, correction);
      correction.signal?.throwIfAborted();
      const json = JSON.stringify(response);
      if (json !== undefined) {
        await recordPlanProposal(id, claim.attempt!, correction.attempt, json);
        execution.proposals.push({ attempt: correction.attempt, json });
      }
      return response;
    };
    // No transaction or database lock spans provider execution/correction attempts.
    const content = await generatePlanWithCorrections(input, persistentProvider, {
      signal: cancellation.signal,
      reportCall: async metadata => { await recordPlanProviderCall(id, claim.attempt!, metadata); },
    });
    return await prisma.$transaction(async database => {
      await lockUserTraining(database, row.userId);
      const current = await database.jobRun.findUniqueOrThrow({ where: { id } });
      if (current.status !== "RUNNING" || current.attemptsStarted !== claim.attempt) return { status: current.status };
      if (!current.leaseExpiresAt || current.leaseExpiresAt.getTime() <= Date.now()) throw new Error("Generation lease lost");
      const newer = await database.jobRun.findFirst({ where: { userId: row.userId, jobType: "COMPUTE_PLAN", id: { gt: id } }, select: { id: true } });
      if (newer || !await generationInputIsCurrent(input, database)) throw new StaleGenerationError();
      const calls = StoredRequestSchema.parse(current.planRequest).providerExecution?.calls ?? [];
      const lastResponse = [...calls].reverse().find(call => call.category === "RESPONSE");
      if (lastResponse) content.generation = { provider: lastResponse.provider, model: lastResponse.model, responseId: lastResponse.responseId, jobRunId: id };
      await saveGeneratedPlan(input, content, database);
      await database.jobRun.update({ where: { id }, data: { status: "SUCCESS", finishedAt: new Date(), leaseExpiresAt: null, nextRetryAt: null, error: null } });
      return { status: "SUCCESS" as const };
    }, { timeout: 15000 });
  } catch (error) {
    if (error instanceof StaleGenerationError || error instanceof ProposalAttemptsExhaustedError || (error instanceof PlanProviderError && !error.retryable)) {
      const status = error instanceof StaleGenerationError ? "CANCELLED" : "FAILED";
      const message = error instanceof StaleGenerationError || error instanceof PlanProviderError ? error.message : `Proposal invalid after ${error.attempts} attempts: ${error.issues.map(issue => `${issue.code}: ${issue.message}`).join("; ").slice(0, 3000)}`;
      await prisma.jobRun.updateMany({ where: { id, status: "RUNNING", attemptsStarted: claim.attempt }, data: {
        status, leaseExpiresAt: null, nextRetryAt: null, finishedAt: new Date(),
        error: message,
      } });
      return { status, error: message };
    }
    const retry = claim.attempt! < PLAN_ATTEMPTS;
    await prisma.jobRun.updateMany({ where: { id, status: "RUNNING", attemptsStarted: claim.attempt }, data: {
      status: retry ? "PENDING" : "FAILED", leaseExpiresAt: null,
      nextRetryAt: retry ? new Date(Date.now() + Math.max(2000 * 2 ** (claim.attempt! - 1), error instanceof PlanProviderError ? error.retryAfterMs : 0)) : null,
      finishedAt: retry ? null : new Date(), error: error instanceof PlanSyncInProgressError ? error.message : error instanceof PlanProviderError ? `${error.category}: ${retry ? "Provider request interrupted; retrying automatically." : "Provider attempt limit reached. Review configuration and request generation again."}` : retry ? "Generation interrupted; retrying automatically." : "Generation failed. Review your settings and request generation again.",
    } });
    throw new Error(retry ? "Generation interrupted; retrying" : "Generation failed");
  } finally {
    clearInterval(heartbeatTimer);
    await heartbeat;
  }
}

export function listUnfinishedPlanRuns(afterId = 0, jobType: "COMPUTE_PLAN" | "REVIEW_BLOCK" = "COMPUTE_PLAN") {
  return prisma.jobRun.findMany({ where: { id: { gt: afterId }, jobType, status: { in: ["PENDING", "RUNNING"] } }, orderBy: { id: "asc" }, take: 100 });
}

export async function failAbandonedPlanRun(id: number, attempt: number, jobType: "COMPUTE_PLAN" | "REVIEW_BLOCK" = "COMPUTE_PLAN") {
  await prisma.jobRun.updateMany({ where: { id, jobType, attemptsStarted: attempt, status: { in: ["PENDING", "RUNNING"] },
    OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: new Date() } }] },
    data: { status: "FAILED", finishedAt: new Date(), leaseExpiresAt: null, error: "Worker stopped before completion. Request the operation again." } });
}

// Renewal is fenced by attempt and lease, and checks for settings edits as well as
// explicit cancellation. An expired owner can never revive its own lease.
export async function renewPlanRunLease(id: number, attempt: number) {
  const row = await prisma.jobRun.findUniqueOrThrow({ where: { id }, select: { userId: true } });
  await prisma.$transaction(async database => {
    await lockUserTraining(database, row.userId);
    const current = await database.jobRun.findUniqueOrThrow({ where: { id } });
    if (current.status !== "RUNNING") throw new StaleGenerationError();
    if (current.attemptsStarted !== attempt || !current.leaseExpiresAt || current.leaseExpiresAt.getTime() <= Date.now()) throw new Error("Generation lease lost");
    const request = StoredRequestSchema.parse(current.planRequest);
    if (request.snapshot && !await generationInputIsCurrent(request.snapshot, database)) throw new StaleGenerationError();
    await database.jobRun.update({ where: { id }, data: { leaseExpiresAt: new Date(Date.now() + PLAN_LEASE_MS) } });
  }, { timeout: 15000 });
}

async function recordPlanProposal(id: number, attempt: number, proposalAttempt: number, json: string) {
  const row = await prisma.jobRun.findUniqueOrThrow({ where: { id }, select: { userId: true } });
  await prisma.$transaction(async database => {
    await lockUserTraining(database, row.userId);
    const current = await database.jobRun.findUniqueOrThrow({ where: { id } });
    if (current.status !== "RUNNING") throw new StaleGenerationError();
    if (current.attemptsStarted !== attempt || !current.leaseExpiresAt || current.leaseExpiresAt.getTime() <= Date.now()) throw new Error("Generation lease lost");
    const request = StoredRequestSchema.parse(current.planRequest);
    const execution = request.providerExecution ?? { calls: [], proposals: [] };
    execution.proposals = [...execution.proposals.filter(value => value.attempt !== proposalAttempt), { attempt: proposalAttempt, json }];
    await database.jobRun.update({ where: { id }, data: { planRequest: { ...request, providerExecution: ProviderExecutionSchema.parse(execution) } } });
  });
}

async function recordPlanProviderCall(id: number, attempt: number, input: ProviderCallMetadata) {
  const metadata = ProviderCallMetadataSchema.parse({ ...input, infrastructureAttempt: attempt });
  // A concise operational record also survives a DB outage. No prompt or raw SDK error.
  console.info(JSON.stringify({ event: "planner.provider_call", jobRunId: id, ...metadata }));
  const row = await prisma.jobRun.findUniqueOrThrow({ where: { id }, select: { userId: true } });
  await prisma.$transaction(async database => {
    await lockUserTraining(database, row.userId);
    const current = await database.jobRun.findUniqueOrThrow({ where: { id } });
    if (current.attemptsStarted !== attempt) return;
    const request = StoredRequestSchema.parse(current.planRequest);
    const execution = request.providerExecution ?? { calls: [], proposals: [] };
    execution.calls.push(metadata);
    await database.jobRun.update({ where: { id }, data: { planRequest: { ...request, providerExecution: ProviderExecutionSchema.parse(execution) } } });
  });
}
