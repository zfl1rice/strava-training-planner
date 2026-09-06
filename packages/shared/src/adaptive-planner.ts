import { PlanSportSchema, type PlanSport } from "./planner.js";
import type { PlanningContext } from "./planning-context.js";
import { FlexiblePlanSchema, type FlexiblePlan, type StructuredWorkout } from "./structured-workouts.js";

export function sessionLimit(context: PlanningContext, date: string, sport: PlanSport): number {
  const settings = context.availability.days.find(day => day.date === date)?.settings;
  if (!settings || !settings.maxSessions || !settings.allowedSports.includes(sport) || (sport === "SWIM" && !settings.poolAccess)) return 0;
  let minutes = settings.availableMinutes;
  for (const restriction of context.restrictions.filter(rule => (!rule.sport || rule.sport === sport) && rule.startDate <= date && (!rule.endDate || rule.endDate >= date))) {
    if (restriction.kind === "NO_TRAINING") return 0;
    if (restriction.kind === "MAX_SESSION_MINUTES") minutes = Math.min(minutes, restriction.maxSessionMinutes!);
  }
  return minutes;
}

export function easyWorkout(id: string, date: string, sport: PlanSport, minutes: number): StructuredWorkout {
  const warmup = Math.min(5, minutes / 5);
  return { kind: "WORKOUT", id, date, sport, templateId: null, title: `Easy ${sport === "BIKE" ? "ride" : sport.toLowerCase()}`,
    effort: "EASY", explanation: "Easy volume allocated from your weekly target and available days.", optional: false, durationMinutes: minutes,
    blocks: [{ repeat: 1, segments: [
      { label: "Warm-up", seconds: warmup * 60, instructions: "Begin gently.", target: { metric: "RPE", lower: 2, upper: 3 } },
      { label: "Main", seconds: (minutes - 2 * warmup) * 60, instructions: "Maintain a comfortable, conversational effort.", target: { metric: "RPE", lower: 3, upper: 4 } },
      { label: "Cool-down", seconds: warmup * 60, instructions: "Finish gently.", target: { metric: "RPE", lower: 2, upper: 3 } },
    ] }],
  };
}

export function generateFlexiblePlan(context: PlanningContext): FlexiblePlan {
  const completed = context.recentTraining.weeks.filter(week => !week.isCurrentWeek);
  const keys = { RUN: "run", BIKE: "bike", SWIM: "swim" } as const;
  const budgets = Object.fromEntries(PlanSportSchema.options.map(sport => {
    const averageMinutes = completed.reduce((sum, week) => sum + week[keys[sport]].durationMinutes, 0) / 3;
    return [sport, { averageMinutes, activeWeeks: completed.filter(week => week[keys[sport]].durationSeconds > 0).length,
      targetMinutes: context.goals[sport] ?? Math.floor(averageMinutes / 5) * 5, plannedMinutes: 0 }];
  })) as FlexiblePlan["budgets"];
  const workouts: StructuredWorkout[] = [];
  // Unconfigured days are unavailable. If every day permits training, reserve
  // the least available day for rest; otherwise an unavailable day supplies rest.
  const hasRest = context.availability.days.some(day => !day.settings || !day.settings.maxSessions || day.settings.availableMinutes < 5);
  const restDate = hasRest ? null : [...context.availability.days].sort((a, b) => a.settings!.availableMinutes - b.settings!.availableMinutes)[0]!.date;
  const sports = [...PlanSportSchema.options].sort((a, b) =>
    context.availability.days.filter(day => sessionLimit(context, day.date, a) >= 5).length -
    context.availability.days.filter(day => sessionLimit(context, day.date, b) >= 5).length);
  for (const sport of sports) {
    while (budgets[sport].plannedMinutes + 5 <= budgets[sport].targetMinutes) {
      const candidates = context.availability.days.filter(day => {
        if (day.date === restDate || !day.settings) return false;
        const sessions = workouts.filter(workout => workout.date === day.date);
        const existing = sessions.find(workout => workout.sport === sport);
        return (existing || sessions.length < day.settings.maxSessions) &&
          sessions.reduce((sum, workout) => sum + workout.durationMinutes, 0) + 5 <= day.settings.availableMinutes &&
          (existing?.durationMinutes ?? 0) + 5 <= sessionLimit(context, day.date, sport);
      }).sort((a, b) => {
        const used = (date: string) => workouts.filter(workout => workout.date === date).reduce((sum, workout) => sum + workout.durationMinutes, 0);
        return used(a.date) / a.settings!.availableMinutes - used(b.date) / b.settings!.availableMinutes || a.date.localeCompare(b.date);
      });
      const day = candidates[0];
      if (!day) break;
      const existing = workouts.find(workout => workout.date === day.date && workout.sport === sport);
      if (existing) Object.assign(existing, easyWorkout(existing.id, day.date, sport, existing.durationMinutes + 5));
      else workouts.push(easyWorkout(`${day.date}-${sport.toLowerCase()}`, day.date, sport, 5));
      budgets[sport].plannedMinutes += 5;
    }
  }
  const assumptions = ["Uses your local week, configured availability, pool access, and restrictions. Unconfigured days are unavailable.",
    "Easy sessions only; at least one rest day. Five-minute allocation prioritizes sports with fewer available days. Race-specific intensity selection is deferred."];
  if (restDate) assumptions.push(`${restDate} reserved for rest because every day was configured for training.`);
  for (const sport of sports) if (budgets[sport].plannedMinutes < budgets[sport].targetMinutes) assumptions.push(`${sport}: ${budgets[sport].targetMinutes - budgets[sport].plannedMinutes} target minutes unscheduled because of availability, session limits, restrictions, or the reserved rest day.`);
  if (!workouts.length) assumptions.push("No workouts fit. Configure availability and weekly goals, or sync enough history for automatic targets.");
  return FlexiblePlanSchema.parse({ version: 2, timeZone: context.athlete.timeZone,
    weekStart: `${context.targetWeek.startDate}T00:00:00.000Z`, weekEnd: `${context.targetWeek.endDate}T00:00:00.000Z`,
    sourceGeneratedAt: context.generatedAt, sourceWeekStarts: completed.map(week => `${week.weekStart}T00:00:00.000Z`),
    mode: Object.values(context.goals).some(goal => goal !== null) ? "CUSTOM" : "HISTORY", goals: context.goals,
    budgets, totalMinutes: workouts.reduce((sum, workout) => sum + workout.durationMinutes, 0), assumptions,
    days: context.availability.days.flatMap<FlexiblePlan["days"][number]>(day => {
      const sessions = workouts.filter(workout => workout.date === day.date);
      return sessions.length ? sessions : [{ kind: "REST" as const, date: day.date, title: "Rest day" as const, durationMinutes: 0 }];
    }),
  });
}
