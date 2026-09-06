import { calendarMonthRange, validateWeeklyPlan, type TrainingCalendarData } from "@pkg/shared";
import { prisma } from "./client.js";

export async function getTrainingCalendar(userId: number, month: string): Promise<TrainingCalendarData> {
  const { start, end } = calendarMonthRange(month);
  const [activities, plans] = await Promise.all([
    prisma.activity.findMany({
      where: { userId, startedAt: { gte: start, lt: end } },
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
    month,
    activities: activities.map(activity => ({
      ...activity,
      startedAt: activity.startedAt.toISOString(),
      stravaActivityId: activity.stravaActivityId?.toString() ?? null,
    })),
    plans: plans.map(plan => ({
      id: plan.id, updatedAt: plan.updatedAt.toISOString(), content: validateWeeklyPlan(plan.content),
    })),
  };
}
