import { buildPlanningContext } from "./planning-context.js";
import { generateFlexiblePlan, calendarWorkouts, easyWorkout, type StructuredWorkout, calendarMonday, localDateAt, addCalendarDays } from "@pkg/shared";
import {
  AUTOMATIC_WEEKLY_GOALS, WeeklyGoalsSchema, generateWeeklyPlan, mondayUtc,
  nextPlanWeek, validateStoredPlan, type WeeklyGoals, type PlannerState, type SavedWeeklyPlan,
  WorkoutStatesSchema,
} from "@pkg/shared";
import { prisma } from "./client.js";
import { getTrainingSummary } from "./training.js";
import type { Prisma } from "@prisma/client";
import { lockUserTraining } from "./training-lock.js";

export class PlanSyncInProgressError extends Error {}
export class PlanHasProtectedWorkoutsError extends Error {}

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
  return { id: row.id, updatedAt: row.updatedAt.toISOString(), content: validateStoredPlan(row.content) };
}

export async function getPlannerState(userId: number, now = new Date()): Promise<PlannerState> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { timeZone: true } });
  const monday = calendarMonday(localDateAt(now, user.timeZone));
  const currentWeekStart = new Date(`${monday}T00:00:00Z`);
  const nextWeekStart = new Date(`${addCalendarDays(monday, 7)}T00:00:00Z`);
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
    const existingPlan = await transaction.weeklyPlan.findUnique({
      where: { userId_weekStart: { userId, weekStart: nextPlanWeek(now) } },
      select: { workoutStates: true },
    });
    if (existingPlan && WorkoutStatesSchema.parse(existingPlan.workoutStates).some(state => state.locked || state.completion !== "PLANNED")) {
      throw new PlanHasProtectedWorkoutsError("This week contains locked or completed workouts. The v1 planner cannot replace them.");
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
      update: { content: plan, workoutStates: [] },
    });
    return serializeSavedPlan(savedPlan);
  }, { isolationLevel: "ReadCommitted", timeout: 10000 });
}


export async function generateAndSaveFlexiblePlan(userId: number, now = new Date(), scope: "NEXT_WEEK" | "REMAINING_WEEK" = "NEXT_WEEK"): Promise<SavedWeeklyPlan> {
  return prisma.$transaction(async database => {
    await lockUserTraining(database, userId);
    const user = await database.user.findUniqueOrThrow({ where: { id: userId }, select: { timeZone: true } });
    const today = localDateAt(now, user.timeZone);
    const weekStartDate = addCalendarDays(calendarMonday(today), scope === "NEXT_WEEK" ? 7 : 0);
    const context = await buildPlanningContext(userId, { now, weekStart: weekStartDate }, database);
    if (context.dataQuality.syncInProgress) throw new PlanSyncInProgressError("Wait for activity sync to finish before generating a plan.");
    const existing = context.existingPlans.find(plan => plan.content.weekStart.slice(0, 10) === weekStartDate);
    const preserved: StructuredWorkout[] = [];
    for (const workout of existing ? calendarWorkouts(existing.content) : []) {
      const state = existing!.workoutStates.find(value => (value.workoutId ?? `${value.date}:${value.templateId}`) === workout.id);
      if (workout.date < today || state?.locked || (state && state.completion !== "PLANNED")) {
        if ("blocks" in workout) { const { steps: _steps, ...original } = workout; preserved.push(original); }
        else preserved.push({ ...easyWorkout(workout.id, workout.date, workout.sport, workout.durationMinutes),
          title: workout.title, templateId: workout.templateId, effort: workout.effort, optional: workout.optional,
          explanation: "Preserved legacy workout; original durations and instructions retained.",
          blocks: [{ repeat: 1, segments: workout.steps.map(step => ({ label: step.label, seconds: step.minutes * 60,
            instructions: step.instructions, target: { metric: "RPE", lower: 2, upper: 4 } })) }],
        });
      }
    }
    const content = generateFlexiblePlan(context, { preserved, fromDate: scope === "REMAINING_WEEK" ? today : weekStartDate });
    const workoutStates = existing?.workoutStates.filter(state => preserved.some(workout => workout.id === (state.workoutId ?? `${state.date}:${state.templateId}`))) ?? [];
    const weekStart = new Date(content.weekStart);
    const saved = await database.weeklyPlan.upsert({ where: { userId_weekStart: { userId, weekStart } },
      create: { userId, weekStart, content, workoutStates }, update: { content, workoutStates,
        updatedAt: new Date(Math.max(Date.now(), Date.parse(existing?.updatedAt ?? "1970-01-01") + 1)) } });
    return serializeSavedPlan(saved);
  }, { timeout: 15000 });
}
