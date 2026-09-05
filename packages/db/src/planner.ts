import {
  AUTOMATIC_WEEKLY_GOALS, WeeklyGoalsSchema, generateWeeklyPlan, mondayUtc,
  nextPlanWeek, validateWeeklyPlan, type WeeklyGoals, type PlannerState, type SavedWeeklyPlan,
} from "@pkg/shared";
import { prisma } from "./client.js";
import { getTrainingSummary } from "./training.js";
import type { Prisma } from "@prisma/client";
import { lockUserTraining } from "./training-lock.js";

export class PlanSyncInProgressError extends Error {}

export async function getWeeklyGoals(
  userId: number,
  database: Prisma.TransactionClient = prisma,
): Promise<WeeklyGoals> {
  const savedGoals = await database.weeklyGoals.findUnique({ where: { userId } });
  if (!savedGoals) return { ...AUTOMATIC_WEEKLY_GOALS };
  return WeeklyGoalsSchema.parse({
    RUN: savedGoals.runMinutes, BIKE: savedGoals.bikeMinutes, SWIM: savedGoals.swimMinutes,
  });
}

export async function saveWeeklyGoals(userId: number, input: WeeklyGoals): Promise<WeeklyGoals> {
  const goals = WeeklyGoalsSchema.parse(input);
  const values = { runMinutes: goals.RUN, bikeMinutes: goals.BIKE, swimMinutes: goals.SWIM };
  await prisma.weeklyGoals.upsert({ where: { userId }, create: { userId, ...values }, update: values });
  return goals;
}

function serializeSavedPlan(row: { id: number; updatedAt: Date; content: unknown }): SavedWeeklyPlan {
  return { id: row.id, updatedAt: row.updatedAt.toISOString(), content: validateWeeklyPlan(row.content) };
}

export async function getPlannerState(userId: number, now = new Date()): Promise<PlannerState> {
  const currentWeekStart = mondayUtc(now);
  const nextWeekStart = nextPlanWeek(now);
  const [goals, savedPlanRows] = await Promise.all([
    getWeeklyGoals(userId),
    prisma.weeklyPlan.findMany({
      where: { userId, weekStart: { in: [currentWeekStart, nextWeekStart] } },
    }),
  ]);
  const currentPlan = savedPlanRows.find(row => row.weekStart.getTime() === currentWeekStart.getTime());
  const nextPlan = savedPlanRows.find(row => row.weekStart.getTime() === nextWeekStart.getTime());
  return {
    goals,
    nextWeekStart: nextWeekStart.toISOString(),
    currentPlan: currentPlan ? serializeSavedPlan(currentPlan) : null,
    nextPlan: nextPlan ? serializeSavedPlan(nextPlan) : null,
  };
}

export async function generateAndSaveWeeklyPlan(userId: number, now = new Date()): Promise<SavedWeeklyPlan> {
  return prisma.$transaction(async transaction => {
    await lockUserTraining(transaction, userId);
    // Check after acquiring the same lock as sync creation. Hold it through save.
    // An existing unfinished sync (including delayed/recovered work) blocks plans;
    // a new sync cannot commit its intent until this transaction completes.
    const activeSync = await transaction.jobRun.findFirst({
      where: { userId, jobType: "STRAVA_SYNC", status: { in: ["PENDING", "RUNNING"] } },
      select: { id: true },
    });
    if (activeSync) {
      throw new PlanSyncInProgressError("Wait for activity sync to finish before generating a plan.");
    }
    const [summary, connection, latestSync, goals] = await Promise.all([
      getTrainingSummary(userId, now, transaction),
      transaction.stravaConnection.findUnique({ where: { userId }, select: { lastSuccessfulSyncAt: true } }),
      transaction.jobRun.findFirst({
        where: { userId, jobType: "STRAVA_SYNC" },
        orderBy: { id: "desc" },
        select: { status: true },
      }),
      getWeeklyGoals(userId, transaction),
    ]);
    const plan = generateWeeklyPlan(summary, goals);
    if (!connection?.lastSuccessfulSyncAt) {
      plan.assumptions.push("No successful activity sync is recorded yet. Sync Strava and regenerate to use your recent training history.");
    } else if (latestSync?.status === "FAILED") {
      plan.assumptions.push("The latest sync failed. This plan uses the activities currently saved, which may be incomplete.");
    }
    // generateWeeklyPlan already validates the plan; only explanatory text changed.
    const weekStart = new Date(plan.weekStart);
    const savedPlan = await transaction.weeklyPlan.upsert({
      where: { userId_weekStart: { userId, weekStart } },
      create: { userId, weekStart, content: plan },
      update: { content: plan },
    });
    return serializeSavedPlan(savedPlan);
  }, { isolationLevel: "ReadCommitted", timeout: 10000 });
}
