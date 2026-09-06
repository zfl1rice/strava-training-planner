import { calendarMonthRange, localDateAt, WorkoutStatesSchema, validateStoredPlan, type TrainingCalendarData } from "@pkg/shared";
import { prisma } from "./client.js";

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
