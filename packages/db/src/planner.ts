import { isDeepStrictEqual } from "node:util";
import { buildPlanningContext } from "./planning-context.js";
import { GenerationInputSchema, generatePlanWithCorrections, type GenerationInput, type FlexiblePlan, type PlanProvider, calendarWorkouts, easyWorkout, type StructuredWorkout, calendarMonday, localDateAt, addCalendarDays } from "@pkg/shared";
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
  await prisma.$transaction(async database => {
    await lockUserTraining(database, userId);
    await database.weeklyGoals.upsert({ where: { userId }, create: { userId, ...values }, update: values });
  });
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
  const [goals, savedPlanRows, generation] = await Promise.all([
    getWeeklyGoals(userId),
    prisma.weeklyPlan.findMany({
      where: { userId, weekStart: { in: [currentWeekStart, nextWeekStart] } },
    }),
    prisma.jobRun.findFirst({ where: { userId, jobType: "COMPUTE_PLAN" }, orderBy: { id: "desc" }, select: { id: true, status: true, error: true } }),
  ]);
  const currentPlan = savedPlanRows.find(row => row.weekStart.getTime() === currentWeekStart.getTime());
  const nextPlan = savedPlanRows.find(row => row.weekStart.getTime() === nextWeekStart.getTime());
  return {
    goals, generation,
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


export class StaleGenerationError extends Error {
  constructor(message = "Planning inputs changed. Request generation again; the existing plan was kept.") { super(message); }
}

// Caller holds the per-athlete training lock for this short read transaction.
export async function prepareGenerationInput(userId: number, now: Date, weekStartDate: string, database: Prisma.TransactionClient): Promise<GenerationInput> {
  const context = await buildPlanningContext(userId, { now, weekStart: weekStartDate }, database);
  if (context.blockTransition) throw new StaleGenerationError(context.blockTransition.rationale);
  if (context.developmentBlock?.weekRole === null) throw new StaleGenerationError("Review, extend, or replace the active block before generating an uncovered week.");
  const today = localDateAt(now, context.athlete.timeZone);
  if (addCalendarDays(weekStartDate, 7) <= today) throw new StaleGenerationError();
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
  return GenerationInputSchema.parse({ version: 1, context, fromDate: today > weekStartDate ? today : weekStartDate, protectedWorkouts: preserved });
}

export async function generationInputIsCurrent(input: GenerationInput, database: Prisma.TransactionClient, now = new Date()) {
  const snapshotTime = new Date(input.context.generatedAt);
  if (localDateAt(now, input.context.athlete.timeZone) !== localDateAt(snapshotTime, input.context.athlete.timeZone)) return false;
  try {
    const current = await prepareGenerationInput(input.context.athlete.id, snapshotTime, input.context.targetWeek.startDate, database);
    return isDeepStrictEqual(current, input);
  } catch (error) {
    if (error instanceof PlanSyncInProgressError || error instanceof StaleGenerationError) return false;
    throw error;
  }
}

// Called only after freshness/ownership checks while holding the same training lock.
export async function saveGeneratedPlan(input: GenerationInput, content: FlexiblePlan, database: Prisma.TransactionClient): Promise<SavedWeeklyPlan> {
  const userId = input.context.athlete.id;
  const existing = input.context.existingPlans.find(plan => plan.content.weekStart === content.weekStart);
  const workoutStates = existing?.workoutStates.filter(state => input.protectedWorkouts.some(workout => workout.id === (state.workoutId ?? `${state.date}:${state.templateId}`))) ?? [];
  const weekStart = new Date(content.weekStart);
  const saved = await database.weeklyPlan.upsert({ where: { userId_weekStart: { userId, weekStart } },
    create: { userId, weekStart, content, workoutStates }, update: { content, workoutStates,
      updatedAt: new Date(Math.max(Date.now(), Date.parse(existing?.updatedAt ?? "1970-01-01") + 1)) } });
  return serializeSavedPlan(saved);
}

export async function generateAndSaveFlexiblePlan(userId: number, now = new Date(), scope: "NEXT_WEEK" | "REMAINING_WEEK" = "NEXT_WEEK", provider?: PlanProvider): Promise<SavedWeeklyPlan> {
  const snapshot = await prisma.$transaction(async database => {
    await lockUserTraining(database, userId);
    const user = await database.user.findUniqueOrThrow({ where: { id: userId }, select: { timeZone: true } });
    const weekStart = addCalendarDays(calendarMonday(localDateAt(now, user.timeZone)), scope === "NEXT_WEEK" ? 7 : 0);
    const latest = await database.jobRun.findFirst({ where: { userId, jobType: "COMPUTE_PLAN" }, orderBy: { id: "desc" }, select: { id: true, status: true } });
    if (latest && ["PENDING", "RUNNING"].includes(latest.status)) throw new Error("A queued generation is already active");
    return { input: await prepareGenerationInput(userId, now, weekStart, database), latestRequestId: latest?.id ?? null };
  }, { timeout: 15000 });
  const content = await generatePlanWithCorrections(snapshot.input, provider);
  return prisma.$transaction(async database => {
    await lockUserTraining(database, userId);
    const latest = await database.jobRun.findFirst({ where: { userId, jobType: "COMPUTE_PLAN" }, orderBy: { id: "desc" }, select: { id: true } });
    if ((latest?.id ?? null) !== snapshot.latestRequestId || !await generationInputIsCurrent(snapshot.input, database, now)) throw new StaleGenerationError();
    return saveGeneratedPlan(snapshot.input, content, database);
  }, { timeout: 15000 });
}
