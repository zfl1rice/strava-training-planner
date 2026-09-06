import { GenerationRequestSchema, LocalDateSchema, PLAN_ATTEMPTS, addCalendarDays, calendarMonday, localDateAt } from "@pkg/shared";
import { prisma } from "./client.js";
import { lockUserTraining } from "./training-lock.js";
import { generateAndSaveFlexiblePlan, PlanSyncInProgressError } from "./planner.js";

export class TrainingBusyError extends Error {}

export async function createOrReusePlanRun(userId: number, input: unknown, now = new Date()) {
  const request = GenerationRequestSchema.parse(input);
  return prisma.$transaction(async database => {
    await lockUserTraining(database, userId);
    if (await database.jobRun.findFirst({ where: { userId, jobType: "STRAVA_SYNC", status: { in: ["PENDING", "RUNNING"] } } })) throw new TrainingBusyError("Wait for activity sync to finish before generating a plan.");
    const existing = await database.jobRun.findFirst({ where: { userId, jobType: "COMPUTE_PLAN", status: { in: ["PENDING", "RUNNING"] } } });
    if (existing) return existing;
    const user = await database.user.findUniqueOrThrow({ where: { id: userId } });
    const weekStart = addCalendarDays(calendarMonday(localDateAt(now, user.timeZone)), request.scope === "NEXT_WEEK" ? 7 : 0);
    return database.jobRun.create({ data: { userId, jobType: "COMPUTE_PLAN", planRequest: { ...request, weekStart }, createdAt: now } });
  });
}

export async function executePlanRun(id: number) {
  const row = await prisma.jobRun.findUnique({ where: { id } });
  if (!row || row.jobType !== "COMPUTE_PLAN") throw new Error("Plan request not found");
  const claim = await prisma.$transaction(async database => {
    await lockUserTraining(database, row.userId);
    const current = await database.jobRun.findUniqueOrThrow({ where: { id } });
    if (!["PENDING", "RUNNING"].includes(current.status)) return { terminal: current.status };
    if ((current.leaseExpiresAt?.getTime() ?? 0) > Date.now() || (current.nextRetryAt?.getTime() ?? 0) > Date.now()) return { deferred: Math.max(current.leaseExpiresAt?.getTime() ?? 0, current.nextRetryAt?.getTime() ?? 0) };
    if (current.attemptsStarted >= PLAN_ATTEMPTS) {
      await database.jobRun.update({ where: { id }, data: { status: "FAILED", error: "Generation attempt limit reached. Request generation again.", finishedAt: new Date(), leaseExpiresAt: null } });
      return { terminal: "FAILED" };
    }
    const attempt = current.attemptsStarted + 1;
    await database.jobRun.update({ where: { id }, data: { status: "RUNNING", attemptsStarted: attempt,
      startedAt: new Date(), error: null, nextRetryAt: null, leaseExpiresAt: new Date(Date.now() + 120000) } });
    return { attempt };
  });
  if ("terminal" in claim) return { status: claim.terminal };
  if ("deferred" in claim) return { status: "DEFERRED", until: claim.deferred };
  try {
    return await prisma.$transaction(async database => {
      await lockUserTraining(database, row.userId);
      const current = await database.jobRun.findUniqueOrThrow({ where: { id } });
      if (current.status !== "RUNNING" || current.attemptsStarted !== claim.attempt || !current.leaseExpiresAt || current.leaseExpiresAt.getTime() <= Date.now()) throw new Error("Generation lease lost");
      const request = GenerationRequestSchema.extend({ weekStart: LocalDateSchema }).parse(current.planRequest);
      await generateAndSaveFlexiblePlan(row.userId, new Date(), request.scope, database, request.weekStart);
      // Commit the result and SUCCESS together; delivery after a lost Redis ack
      // observes SUCCESS and never regenerates a second time.
      await database.jobRun.update({ where: { id }, data: { status: "SUCCESS", finishedAt: new Date(), leaseExpiresAt: null, nextRetryAt: null, error: null } });
      return { status: "SUCCESS" };
    }, { timeout: 20000 });
  } catch (error) {
    const retry = claim.attempt! < PLAN_ATTEMPTS;
    await prisma.jobRun.updateMany({ where: { id, status: "RUNNING", attemptsStarted: claim.attempt }, data: {
      status: retry ? "PENDING" : "FAILED", leaseExpiresAt: null,
      nextRetryAt: retry ? new Date(Date.now() + 2000 * 2 ** (claim.attempt! - 1)) : null,
      finishedAt: retry ? null : new Date(), error: error instanceof PlanSyncInProgressError ? error.message : retry ? "Generation interrupted; retrying automatically." : "Generation failed. Review your settings and request generation again.",
    } });
    throw new Error(retry ? "Generation interrupted; retrying" : "Generation failed");
  }
}

export function listUnfinishedPlanRuns(afterId = 0) {
  return prisma.jobRun.findMany({ where: { id: { gt: afterId }, jobType: "COMPUTE_PLAN", status: { in: ["PENDING", "RUNNING"] } }, orderBy: { id: "asc" }, take: 100 });
}

export async function failAbandonedPlanRun(id: number, attempt: number) {
  await prisma.jobRun.updateMany({ where: { id, jobType: "COMPUTE_PLAN", attemptsStarted: attempt, status: { in: ["PENDING", "RUNNING"] },
    OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: new Date() } }] },
    data: { status: "FAILED", finishedAt: new Date(), leaseExpiresAt: null, error: "Generation stopped before completion. Request generation again." } });
}
