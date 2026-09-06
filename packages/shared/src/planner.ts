import type { StoredPlan } from "./structured-workouts.js";
import { z } from "zod";
import { mondayUtc, type TrainingSummary } from "./training.js";

const DAY_MS = 86400000;
export const PLAN_VERSION = 1;
export const PlanSportSchema = z.enum(["RUN", "BIKE", "SWIM"]);
export type PlanSport = z.infer<typeof PlanSportSchema>;
const sportKeys = { RUN: "run", BIKE: "bike", SWIM: "swim" } as const;

// Version 1 policy: Monday is index 0 and stays free; one workout per day.
// Keep this schedule stable for saved v1 plans. New scheduling policies need a new version.
const WEEKLY_WORKOUT_SLOTS = {
  RUN: { shorter: { templateId: "run-easy", dayIndex: 1 }, longer: { templateId: "run-long", dayIndex: 6 } },
  BIKE: { shorter: { templateId: "bike-endurance", dayIndex: 3 }, longer: { templateId: "bike-long", dayIndex: 5 } },
  SWIM: { shorter: { templateId: "swim-technique", dayIndex: 2 }, longer: { templateId: "swim-steady", dayIndex: 4 } },
} as const;

const GoalMinutesSchema = z.number().int().min(0).max(10080).multipleOf(5).nullable();
export const WeeklyGoalsSchema = z.object({
  RUN: GoalMinutesSchema, BIKE: GoalMinutesSchema, SWIM: GoalMinutesSchema,
}).strict();
export type WeeklyGoals = z.infer<typeof WeeklyGoalsSchema>;
export const AUTOMATIC_WEEKLY_GOALS: WeeklyGoals = { RUN: null, BIKE: null, SWIM: null };

export const WorkoutTemplateSchema = z.object({
  id: z.string(), sport: PlanSportSchema, title: z.string(),
  effort: z.enum(["EASY", "MODERATE", "HARD"]),
  minMinutes: z.number().int().positive(), maxMinutes: z.number().int().positive(),
  warmupMinutes: z.number().int().positive(), cooldownMinutes: z.number().int().positive(),
  warmup: z.string(), main: z.string(), cooldown: z.string(),
});

export const WORKOUT_TEMPLATES = WorkoutTemplateSchema.array().parse([
  { id: "run-easy", sport: "RUN", title: "Easy run", effort: "EASY", minMinutes: 10, maxMinutes: 45,
    warmupMinutes: 2, cooldownMinutes: 2, warmup: "Walk or jog gently.",
    main: "Run at a relaxed, conversational effort. Take walking breaks as needed.", cooldown: "Walk or jog gently." },
  { id: "run-long", sport: "RUN", title: "Longer easy run", effort: "EASY", minMinutes: 15, maxMinutes: 60,
    warmupMinutes: 3, cooldownMinutes: 3, warmup: "Start with gentle walking or jogging.",
    main: "Keep the pace conversational throughout. This is an easy session, not a speed workout.", cooldown: "Ease into a walk." },
  { id: "bike-endurance", sport: "BIKE", title: "Easy endurance ride", effort: "EASY", minMinutes: 15, maxMinutes: 60,
    warmupMinutes: 3, cooldownMinutes: 3, warmup: "Pedal gently in an easy gear.",
    main: "Ride at a comfortable effort with relaxed, steady pedaling.", cooldown: "Reduce the effort and pedal gently." },
  { id: "bike-long", sport: "BIKE", title: "Longer easy ride", effort: "EASY", minMinutes: 20, maxMinutes: 120,
    warmupMinutes: 5, cooldownMinutes: 5, warmup: "Build gradually from gentle pedaling.",
    main: "Maintain an easy, conversational effort. Avoid adding hard intervals.", cooldown: "Finish with gentle pedaling." },
  { id: "swim-technique", sport: "SWIM", title: "Easy technique swim", effort: "EASY", minMinutes: 10, maxMinutes: 30,
    warmupMinutes: 2, cooldownMinutes: 2, warmup: "Swim gently using a familiar stroke.",
    main: "Swim short, easy lengths, focusing on relaxed breathing and smooth strokes. Rest between lengths as needed.", cooldown: "Finish with gentle lengths." },
  { id: "swim-steady", sport: "SWIM", title: "Easy steady swim", effort: "EASY", minMinutes: 10, maxMinutes: 45,
    warmupMinutes: 2, cooldownMinutes: 2, warmup: "Begin with gentle lengths.",
    main: "Swim easy lengths or short blocks at a comfortable effort. Include recovery between blocks.", cooldown: "Swim a few relaxed lengths." },
]);

const RestDaySchema = z.object({
  kind: z.literal("REST"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  title: z.literal("Rest day"), durationMinutes: z.literal(0),
});
const WorkoutDaySchema = z.object({
  kind: z.literal("WORKOUT"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  templateId: z.string(), sport: PlanSportSchema, title: z.string(),
  effort: z.enum(["EASY", "MODERATE", "HARD"]), durationMinutes: z.number().int().positive(),
  optional: z.boolean(),
  steps: z.array(z.object({ label: z.string(), minutes: z.number().int().positive(), instructions: z.string() })).length(3),
});
const SportBudgetSchema = z.object({
  averageMinutes: z.number().nonnegative(), activeWeeks: z.number().int().min(0).max(3),
  targetMinutes: z.number().int().nonnegative(), plannedMinutes: z.number().int().nonnegative(),
});

export const WeeklyPlanSchema = z.object({
  version: z.literal(PLAN_VERSION), timeZone: z.literal("UTC"),
  weekStart: z.string().datetime(), weekEnd: z.string().datetime(),
  sourceGeneratedAt: z.string().datetime(), sourceWeekStarts: z.array(z.string().datetime()).length(3),
  mode: z.enum(["HISTORY", "STARTER", "CUSTOM"]), assumptions: z.array(z.string()),
  goals: WeeklyGoalsSchema.default(AUTOMATIC_WEEKLY_GOALS),
  budgets: z.object({ RUN: SportBudgetSchema, BIKE: SportBudgetSchema, SWIM: SportBudgetSchema }),
  days: z.array(z.discriminatedUnion("kind", [RestDaySchema, WorkoutDaySchema])).length(7),
  totalMinutes: z.number().int().nonnegative(),
});

export type WeeklyPlan = z.infer<typeof WeeklyPlanSchema>;
export type SavedWeeklyPlan = { id: number; updatedAt: string; content: StoredPlan; workoutStates?: import("./athlete-profile.js").AthleteWorkoutStates };
export type PlannerState = { goals: WeeklyGoals; nextWeekStart: string; currentPlan: SavedWeeklyPlan | null; nextPlan: SavedWeeklyPlan | null };

export function nextPlanWeek(now: Date): Date {
  return new Date(mondayUtc(now).getTime() + 7 * DAY_MS);
}

const roundDownToFiveMinutes = (minutes: number) => Math.floor(minutes / 5) * 5;
const getWorkoutTemplate = (templateId: string) => {
  const workoutTemplate = WORKOUT_TEMPLATES.find(value => value.id === templateId);
  if (!workoutTemplate) throw new Error("Unknown workout template");
  return workoutTemplate;
};

export function validateWeeklyPlan(value: unknown): WeeklyPlan {
  const plan = WeeklyPlanSchema.parse(value);
  const hasCustomGoals = PlanSportSchema.options.some(sport => plan.goals[sport] !== null);
  if (hasCustomGoals !== (plan.mode === "CUSTOM")) throw new Error("Plan mode does not match its goals");
  const start = new Date(plan.weekStart);
  if (mondayUtc(start).getTime() !== start.getTime() || Date.parse(plan.weekEnd) !== start.getTime() + 7 * DAY_MS) {
    throw new Error("Plan must cover one Monday-to-Sunday UTC week");
  }
  const totals = { RUN: 0, BIKE: 0, SWIM: 0 };
  let previousDayWasHard = false;
  for (const [index, day] of plan.days.entries()) {
    if (day.date !== new Date(start.getTime() + index * DAY_MS).toISOString().slice(0, 10)) throw new Error("Invalid plan schedule");
    if (day.kind === "REST") {
      previousDayWasHard = false;
      continue;
    }
    const scheduledSlot = Object.values(WEEKLY_WORKOUT_SLOTS[day.sport]).find(slot => slot.dayIndex === index);
    if (scheduledSlot?.templateId !== day.templateId) throw new Error("Workout is outside its scheduled slot");
    const definition = getWorkoutTemplate(day.templateId);
    if (day.sport !== definition.sport || day.effort !== definition.effort ||
      day.durationMinutes < definition.minMinutes || day.durationMinutes > definition.maxMinutes ||
      day.durationMinutes % 5 !== 0 || day.steps.reduce((sum, step) => sum + step.minutes, 0) !== day.durationMinutes) {
      throw new Error("Workout does not fit its template");
    }
    if (previousDayWasHard && day.effort === "HARD") throw new Error("Consecutive hard sessions are not allowed");
    previousDayWasHard = day.effort === "HARD";
    totals[day.sport] += day.durationMinutes;
  }
  if (plan.days[0]?.kind !== "REST") throw new Error("Monday must be a rest day");
  for (const sport of PlanSportSchema.options) {
    const budget = plan.budgets[sport];
    const goalMinutes = plan.goals[sport];
    const differsFromCustomGoal = goalMinutes !== null && budget.targetMinutes !== goalMinutes;
    const exceedsAutomaticHistory = plan.mode !== "STARTER" && goalMinutes === null &&
      budget.targetMinutes > budget.averageMinutes;
    if (totals[sport] !== budget.plannedMinutes || totals[sport] > budget.targetMinutes ||
      differsFromCustomGoal || exceedsAutomaticHistory) {
      throw new Error("Plan exceeds its sport budget");
    }
  }
  if (plan.totalMinutes !== totals.RUN + totals.BIKE + totals.SWIM) throw new Error("Invalid weekly total");
  return plan;
}

export function generateWeeklyPlan(summary: TrainingSummary, requestedGoals: WeeklyGoals = AUTOMATIC_WEEKLY_GOALS): WeeklyPlan {
  const goals = WeeklyGoalsSchema.parse(requestedGoals);
  const hasCustomGoals = PlanSportSchema.options.some(sport => goals[sport] !== null);
  const now = new Date(summary.generatedAt);
  const currentMonday = mondayUtc(now).getTime();
  const sourceWeeks = [1, 2, 3].map(offset => {
    const expected = new Date(currentMonday - offset * 7 * DAY_MS).toISOString();
    const week = summary.weeks.find(value => value.weekStart === expected);
    if (!week || week.isCurrentWeek) throw new Error("Three completed training weeks are required");
    return week;
  });
  const budgets = Object.fromEntries(PlanSportSchema.options.map(sport => {
    const key = sportKeys[sport];
    const totalSeconds = sourceWeeks.reduce((sum, week) => sum + week[key].durationSeconds, 0);
    const averageMinutes = totalSeconds / 60 / sourceWeeks.length;
    const activeWeeks = sourceWeeks.filter(week => week[key].durationSeconds > 0).length;
    return [sport, { averageMinutes, activeWeeks, targetMinutes: goals[sport] ?? roundDownToFiveMinutes(averageMinutes), plannedMinutes: 0 }];
  })) as WeeklyPlan["budgets"];
  const isStarterPlan = !hasCustomGoals && PlanSportSchema.options.every(sport => budgets[sport].averageMinutes === 0);
  const assumptions = [
    "Based on the previous three completed UTC weeks; the unfinished current week and other activity types do not increase the budget.",
    "One session per day, Monday rest, and easy efforts only. Durations include warm-up and cool-down.",
  ];
  if (hasCustomGoals) assumptions.push("Custom goals override the recent average for the selected sports. Blank sports use recorded history (zero when none exists). Goals use five-minute blocks; template limits still apply.");
  if (isStarterPlan) {
    budgets.RUN.targetMinutes = 10;
    budgets.BIKE.targetMinutes = 20;
    budgets.SWIM.targetMinutes = 10;
    assumptions.push("No completed-week swim, bike, or run volume was found. This generic optional starter schedule is not an estimate of your fitness. Skip sessions that do not suit your experience.");
  }
  const weekStart = nextPlanWeek(now);
  const days: WeeklyPlan["days"] = Array.from({ length: 7 }, (_, index) => ({
    kind: "REST", date: new Date(weekStart.getTime() + index * DAY_MS).toISOString().slice(0, 10),
    title: "Rest day", durationMinutes: 0,
  }));
  function scheduleWorkout(dayIndex: number, templateId: string, minutes: number) {
    const definition = getWorkoutTemplate(templateId);
    days[dayIndex] = {
      kind: "WORKOUT", date: days[dayIndex]!.date, templateId, sport: definition.sport,
      title: definition.title, effort: definition.effort, durationMinutes: minutes, optional: isStarterPlan,
      steps: [
        { label: "Warm-up", minutes: definition.warmupMinutes, instructions: definition.warmup },
        { label: "Main session", minutes: minutes - definition.warmupMinutes - definition.cooldownMinutes, instructions: definition.main },
        { label: "Cool-down", minutes: definition.cooldownMinutes, instructions: definition.cooldown },
      ],
    };
    budgets[definition.sport].plannedMinutes += minutes;
  }
  for (const sport of PlanSportSchema.options) {
    const budget = budgets[sport];
    const { shorter, longer } = WEEKLY_WORKOUT_SLOTS[sport];
    const shorterTemplate = getWorkoutTemplate(shorter.templateId);
    const longerTemplate = getWorkoutTemplate(longer.templateId);
    if (!isStarterPlan && budget.activeWeeks < 3) {
      assumptions.push(`${sport}: activity was recorded in ${budget.activeWeeks} of three completed weeks. Missing weeks count as zero, so this baseline may be incomplete.`);
    }
    if (budget.targetMinutes >= shorterTemplate.minMinutes + longerTemplate.minMinutes) {
      const preferredShortMinutes = roundDownToFiveMinutes(budget.targetMinutes * 0.4);
      // Shift overflow to the short session when the long session reaches its cap.
      const shortMinutes = Math.min(shorterTemplate.maxMinutes, Math.max(
        shorterTemplate.minMinutes, preferredShortMinutes, budget.targetMinutes - longerTemplate.maxMinutes,
      ));
      const longMinutes = Math.min(longerTemplate.maxMinutes, budget.targetMinutes - shortMinutes);
      scheduleWorkout(shorter.dayIndex, shorter.templateId, shortMinutes);
      scheduleWorkout(longer.dayIndex, longer.templateId, longMinutes);
    } else if (budget.targetMinutes >= shorterTemplate.minMinutes) {
      scheduleWorkout(shorter.dayIndex, shorter.templateId, Math.min(shorterTemplate.maxMinutes, budget.targetMinutes));
    } else {
      assumptions.push(`${sport}: no workout fits the ${goals[sport] === null ? "automatic" : "custom"} target of ${budget.targetMinutes} minutes.`);
    }
    if (budget.plannedMinutes < budget.targetMinutes) {
      assumptions.push(`${sport}: ${budget.targetMinutes - budget.plannedMinutes} budgeted minutes were left unused to keep sessions within template limits.`);
    }
  }
  return validateWeeklyPlan({
    version: PLAN_VERSION, timeZone: "UTC", weekStart: weekStart.toISOString(),
    weekEnd: new Date(weekStart.getTime() + 7 * DAY_MS).toISOString(),
    sourceGeneratedAt: summary.generatedAt, sourceWeekStarts: sourceWeeks.map(week => week.weekStart),
    mode: hasCustomGoals ? "CUSTOM" : isStarterPlan ? "STARTER" : "HISTORY", goals, assumptions, budgets, days,
    totalMinutes: budgets.RUN.plannedMinutes + budgets.BIKE.plannedMinutes + budgets.SWIM.plannedMinutes,
  });
}
