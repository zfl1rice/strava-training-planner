import { resolveWorkoutTargets, workoutEffort } from "./workout-targets.js";
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

export function generateFlexiblePlan(context: PlanningContext, options: { preserved?: StructuredWorkout[]; fromDate?: string } = {}): FlexiblePlan {
  const completed = context.recentTraining.weeks.filter(week => !week.isCurrentWeek);
  const budgets = planningBudgets(context);
  const adjustmentFor = (date: string, sport: PlanSport) => matchingAdjustment(context, date, sport);
  const desired = allocationTargets(context);
  const workouts: StructuredWorkout[] = structuredClone(options.preserved ?? []);
  const protectedIds = new Set(workouts.map(workout => workout.id));
  for (const sport of PlanSportSchema.options) budgets[sport].plannedMinutes = workouts.filter(workout => workout.sport === sport).reduce((sum, workout) => sum + workout.durationMinutes, 0);
  // Fallback preference, not proposal validity: if every day permits training, reserve
  // the least available day for rest; otherwise an unavailable day supplies rest.
  const hasRest = context.availability.days.some(day => !day.settings || !day.settings.maxSessions || day.settings.availableMinutes < 5);
  const restDate = hasRest ? null : [...context.availability.days].sort((a, b) => a.settings!.availableMinutes - b.settings!.availableMinutes)[0]!.date;
  const sports = [...PlanSportSchema.options].sort((a, b) =>
    context.availability.days.filter(day => sessionLimit(context, day.date, a) >= 5).length -
    context.availability.days.filter(day => sessionLimit(context, day.date, b) >= 5).length);
  for (const sport of sports) {
    while (budgets[sport].plannedMinutes + 5 <= desired[sport]) {
      const candidates = context.availability.days.filter(day => {
        if (day.date === restDate || !day.settings || (options.fromDate && day.date < options.fromDate)) return false;
        const sessions = workouts.filter(workout => workout.date === day.date);
        const existing = sessions.find(workout => workout.sport === sport);
        if (existing && protectedIds.has(existing.id)) return false;
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
  for (const workout of workouts) {
    if (protectedIds.has(workout.id)) continue;
    for (const block of workout.blocks) for (const segment of block.segments) {
      const main = segment.label === "Main";
      if (workout.sport === "BIKE" && context.fitness.effective.cycling.value) segment.target = { metric: "FTP_PERCENT", lower: main ? 60 : 45, upper: main ? 70 : 55 };
      if (workout.sport === "RUN" && context.fitness.definitions.running.thresholdPace?.value) segment.target = { metric: "THRESHOLD_PACE_PERCENT", lower: main ? 115 : 125, upper: main ? 130 : 140 };
      if (workout.sport === "SWIM" && context.fitness.effective.swimming.value) segment.target = { metric: "THRESHOLD_PACE_PERCENT", lower: main ? 110 : 120, upper: main ? 120 : 130 };
    }
    const intensity = adjustmentFor(workout.date, workout.sport)?.intensityPercent ?? 100;
    for (const block of workout.blocks) for (const segment of block.segments) {
      const factor = segment.target.metric === "THRESHOLD_PACE_PERCENT" ? 100 / intensity : intensity / 100;
      const max = segment.target.metric === "RPE" ? 10 : segment.target.metric === "MAX_HR_PERCENT" ? 100 : 300;
      segment.target.lower = Math.min(max, Math.round(segment.target.lower * factor * 100) / 100);
      segment.target.upper = Math.min(max, Math.round(segment.target.upper * factor * 100) / 100);
    }
    workout.effort = workoutEffort(workout);
    if (workout.effort !== "EASY") {
      workout.title = `${workout.effort === "HARD" ? "Hard" : "Moderate"} ${workout.sport === "BIKE" ? "ride" : workout.sport.toLowerCase()} (adjusted)`;
      for (const block of workout.blocks) for (const segment of block.segments) if (segment.label === "Main") segment.instructions = "Follow the adjusted target. Reduce effort or stop if you cannot complete it comfortably.";
    }
    Object.assign(workout, resolveWorkoutTargets(workout, context.fitness, context.generatedAt));
  }
  const hardDates: string[] = [];
  for (const workout of [...workouts].sort((a, b) => a.date.localeCompare(b.date))) {
    if (workout.effort !== "HARD") continue;
    if (protectedIds.has(workout.id)) { hardDates.push(workout.date); continue; }
    if (hardDates.length >= 2 || workouts.some(other => protectedIds.has(other.id) && other.effort === "HARD" && Math.abs(Date.parse(other.date) - Date.parse(workout.date)) <= 86400000) || hardDates.some(date => Math.abs(Date.parse(date) - Date.parse(workout.date)) <= 86400000)) {
      Object.assign(workout, resolveWorkoutTargets(easyWorkout(workout.id, workout.date, workout.sport, workout.durationMinutes), context.fitness, context.generatedAt));
      workout.explanation += " Requested intensity increase was limited to preserve spacing between hard sessions.";
    } else hardDates.push(workout.date);
  }
  const assumptions = ["Uses your local week, availability, pool access, and restrictions. Days without saved settings are available by default.",
    "Template sessions with explicit intensity adjustments; at least one rest day, at most two hard sessions, and no consecutive hard days. Allocation prioritizes sports with fewer available days. Race-specific selection is deferred."];
  if (options.preserved?.length) assumptions.push("Past, completed, stopped, modified, and locked workouts were preserved. New settings apply only to replaceable workouts.");
  if (context.adjustments.length) assumptions.push("Temporary volume changes are prorated by their days in this week. Intensity reductions apply to matching workouts; increases may be limited by hard-session spacing. Goals remain unchanged.");
  if (restDate) assumptions.push(`${restDate} reserved for rest because every day was available for training.`);
  for (const sport of sports) if (budgets[sport].plannedMinutes < budgets[sport].targetMinutes) assumptions.push(`${sport}: ${budgets[sport].targetMinutes - budgets[sport].plannedMinutes} target minutes unscheduled because of availability, session limits, restrictions, or the reserved rest day.`);
  if (!workouts.length) assumptions.push("No workouts fit. Check weekly goals, availability limits, and restrictions, or sync enough history for automatic targets.");
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

export function planningBudgets(context: PlanningContext): FlexiblePlan["budgets"] {
  const completed = context.recentTraining.weeks.filter(week => !week.isCurrentWeek);
  const keys = { RUN: "run", BIKE: "bike", SWIM: "swim" } as const;
  const budgets = Object.fromEntries(PlanSportSchema.options.map(sport => {
    const averageMinutes = completed.reduce((sum, week) => sum + week[keys[sport]].durationMinutes, 0) / 3;
    return [sport, { averageMinutes, activeWeeks: completed.filter(week => week[keys[sport]].durationSeconds > 0).length,
      targetMinutes: context.goals[sport] ?? Math.floor(averageMinutes / 5) * 5, plannedMinutes: 0 }];
  })) as FlexiblePlan["budgets"];
  return budgets;
}

export function matchingAdjustment(context: PlanningContext, date: string, sport: PlanSport) {
  return [...context.adjustments].reverse().find(item => (!item.sport || item.sport === sport) && item.startDate <= date && item.endDate >= date);
}

export function allocationTargets(context: PlanningContext): Record<PlanSport, number> {
  const budgets = planningBudgets(context);
  return Object.fromEntries(PlanSportSchema.options.map(sport => {
    const adjusted = Math.floor(budgets[sport].targetMinutes * context.availability.days.reduce((sum, day) => sum + (matchingAdjustment(context, day.date, sport)?.volumePercent ?? 100), 0) / 700 / 5) * 5;
    return [sport, adjusted];
  })) as Record<PlanSport, number>;
}
