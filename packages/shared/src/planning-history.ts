import { z } from "zod";
import { PlanSportSchema } from "./planner.js";
import { addCalendarDays, calendarMonday, LocalDateSchema } from "./planning-dates.js";
import { summarizeTraining, type TrainingActivity } from "./training.js";

const SportHistorySchema = z.object({
  minutes: z.number().nonnegative(), sessions: z.number().int().nonnegative(), longestMinutes: z.number().nonnegative(),
  // These are completed plan targets, not measured intensity from activity streams.
  completedPlanSessions: z.number().int().nonnegative(), completedPlanHardSessions: z.number().int().nonnegative(),
}).strict();
export const PlanningHistorySchema = z.object({
  windowWeeks: z.literal(12),
  weeks: z.array(z.object({ weekStart: LocalDateSchema, weekEnd: LocalDateSchema,
    sports: z.object({ RUN: SportHistorySchema, BIKE: SportHistorySchema, SWIM: SportHistorySchema }).strict(),
  }).strict()).length(12),
  notes: z.array(z.string()),
}).strict();
export type PlanningHistory = z.infer<typeof PlanningHistorySchema>;

// Activity dates have already been converted to local calendar labels by the DB layer.
export function summarizePlanningHistory(activities: TrainingActivity[], today: string,
  completed: { date: string; sport: "RUN" | "BIKE" | "SWIM"; hard: boolean }[] = []): PlanningHistory {
  const monday = calendarMonday(today);
  const keys = { RUN: "run", BIKE: "bike", SWIM: "swim" } as const;
  return PlanningHistorySchema.parse({ windowWeeks: 12,
    weeks: Array.from({ length: 12 }, (_, index) => {
      const weekStart = addCalendarDays(monday, -7 * (index + 1));
      const weekEnd = addCalendarDays(weekStart, 7);
      const weekly = summarizeTraining(activities, new Date(`${addCalendarDays(weekEnd, -1)}T23:59:59.999Z`)).weeks[0]!;
      return { weekStart, weekEnd, sports: Object.fromEntries(PlanSportSchema.options.map(sport => {
        const matches = activities.filter(activity => activity.type === sport && activity.startedAt.toISOString().slice(0, 10) >= weekStart && activity.startedAt.toISOString().slice(0, 10) < weekEnd);
        const reported = completed.filter(workout => workout.sport === sport && workout.date >= weekStart && workout.date < weekEnd);
        return [sport, { minutes: weekly[keys[sport]].durationMinutes, sessions: weekly[keys[sport]].activityCount,
          longestMinutes: Math.max(0, ...matches.map(activity => activity.durationSeconds / 60)),
          completedPlanSessions: reported.length, completedPlanHardSessions: reported.filter(workout => workout.hard).length }];
      })) };
    }),
    notes: ["Recorded activity is evidence of volume, not proof of tolerance. Empty weeks may reflect missing ingestion.",
      "Completed plan intensity is a partial target-based proxy. Actual activity intensity and recovery hours are unknown.",
      "Established volume comparisons use the median of the three highest nonzero recorded weeks in this 12-week window; fewer than three is sparse evidence."],
  });
}
