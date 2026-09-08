import { calendarMonthRange, localDateAt, WorkoutStatesSchema, validateStoredPlan, type TrainingCalendarData } from "@pkg/shared";
import { prisma } from "./client.js";
import { ClearWeekRequestSchema, removeEligibleWeekWorkouts } from "@pkg/shared";
import { lockUserTraining } from "./training-lock.js";
import { TrainingBusyError } from "./plan-jobs.js";

export async function clearPlannedWeek(userId: number, input: unknown, now = new Date()) {
  const request = ClearWeekRequestSchema.parse(input);
  return prisma.$transaction(async database => {
    await lockUserTraining(database, userId);
    const user = await database.user.findUniqueOrThrow({ where: { id: userId }, select: { timeZone: true } });
    if (request.today !== localDateAt(now, user.timeZone)) throw new TrainingBusyError("The date changed. Reload before clearing this week.");
    const busy = await database.jobRun.findFirst({ where: { userId, status: { in: ["PENDING", "RUNNING"] }, jobType: { in: ["COMPUTE_PLAN", "REVIEW_BLOCK", "STRAVA_SYNC"] } }, select: { id: true } });
    if (busy) throw new TrainingBusyError("Wait for generation, review or activity sync to finish before clearing a week.");
    const row = await database.weeklyPlan.findFirst({ where: { id: request.planId, userId } });
    if (!row || row.updatedAt.toISOString() !== request.expectedUpdatedAt) throw new TrainingBusyError("The plan changed. Reload the calendar and confirm again.");
    const result = removeEligibleWeekWorkouts({ id: row.id, updatedAt: row.updatedAt.toISOString(), content: validateStoredPlan(row.content), workoutStates: WorkoutStatesSchema.parse(row.workoutStates) }, request.today);
    if (result.removedCount) await database.weeklyPlan.update({ where: { id: row.id }, data: {
      content: result.content, workoutStates: result.workoutStates,
      updatedAt: new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1)),
    } });
    return { removedCount: result.removedCount };
  });
}

export async function getTrainingCalendar(userId: number, month: string): Promise<TrainingCalendarData> {
  const { start, end } = calendarMonthRange(month);
  const { timeZone } = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { timeZone: true } });
  const [activities, plans] = await Promise.all([
    prisma.activity.findMany({
      where: { userId, startedAt: { gte: new Date(start.getTime() - 2 * 86400000), lt: new Date(end.getTime() + 2 * 86400000) } },
      orderBy: [{ startedAt: "asc" }, { id: "asc" }],
      select: {
        id: true, name: true, type: true, startedAt: true, durationSeconds: true,
        distanceMeters: true, stravaActivityId: true,
      },
    }),
    prisma.weeklyPlan.findMany({
      where: { userId, weekStart: { gte: start, lt: end } },
      orderBy: { weekStart: "asc" },
    }),
  ]);
  return {
    month, ...(timeZone === "UTC" ? {} : { timeZone }),
    activities: activities.filter(activity => { const date = localDateAt(activity.startedAt, timeZone); return date >= start.toISOString().slice(0, 10) && date < end.toISOString().slice(0, 10); }).map(activity => ({
      ...activity,
      startedAt: activity.startedAt.toISOString(),
      stravaActivityId: activity.stravaActivityId?.toString() ?? null,
    })),
    plans: plans.map(plan => ({
      ...(WorkoutStatesSchema.parse(plan.workoutStates).length ? { workoutStates: WorkoutStatesSchema.parse(plan.workoutStates) } : {}),
      id: plan.id, updatedAt: plan.updatedAt.toISOString(), content: validateStoredPlan(plan.content),
    })),
  };
}
