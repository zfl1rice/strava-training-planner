import { z } from "zod";
import { LocalDateSchema, addCalendarDays } from "./planning-dates.js";
import { PlanSportSchema, type SavedWeeklyPlan } from "./planner.js";
import { calendarWorkouts, validateStoredPlan } from "./structured-workouts.js";

export const ClearWeekRequestSchema = z.object({
  planId: z.number().int().positive(), expectedUpdatedAt: z.string().datetime(),
  // The confirmation count is valid only on the same athlete-local date.
  today: LocalDateSchema,
}).strict();

export function clearableWorkouts(plan: SavedWeeklyPlan, today: string) {
  LocalDateSchema.parse(today);
  return calendarWorkouts(plan.content).filter(workout => {
    const state = plan.workoutStates?.find(value => (value.workoutId ?? `${value.date}:${value.templateId}`) === workout.id);
    return workout.date >= today && !state?.locked && (!state || state.completion === "PLANNED") && !state?.feedback;
  });
}

/** Retain the plan row, original workout bodies, goals and all surviving states. */
export function removeEligibleWeekWorkouts(plan: SavedWeeklyPlan, today: string) {
  const removed = new Set(clearableWorkouts(plan, today).map(workout => workout.id));
  const content = structuredClone(plan.content);
  for (let index = content.days.length - 1; index >= 0; index--) {
    const day = content.days[index]!;
    if (day.kind === "WORKOUT" && removed.has("id" in day ? day.id : `${day.date}:${day.templateId}`)) content.days.splice(index, 1);
  }
  for (let offset = 0; offset < 7; offset++) {
    const date = addCalendarDays(content.weekStart.slice(0, 10), offset);
    if (!content.days.some(day => day.date === date)) content.days.push({ kind: "REST", date, title: "Rest day", durationMinutes: 0 });
  }
  content.days.sort((a, b) => a.date.localeCompare(b.date));
  content.totalMinutes = content.days.reduce((sum, day) => sum + day.durationMinutes, 0);
  for (const sport of PlanSportSchema.options) content.budgets[sport].plannedMinutes = content.days.reduce((sum, day) => sum + (day.kind === "WORKOUT" && day.sport === sport ? day.durationMinutes : 0), 0);
  if (content.version === 2) delete content.analysis; // Analysis described the original full week.
  if (removed.size) content.assumptions.push(`Athlete cleared ${removed.size} uncompleted planned workouts on ${today}. Goals and protected workouts were retained.`);
  return { content: validateStoredPlan(content), workoutStates: (plan.workoutStates ?? []).filter(state => !removed.has(state.workoutId ?? `${state.date}:${state.templateId}`)), removedCount: removed.size };
}
