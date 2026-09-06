import { z } from "zod";
import { PlanningContextSchema, type PlanningContext } from "./planning-context.js";
import { LocalDateSchema } from "./planning-dates.js";
import { PlanSportSchema } from "./planner.js";
import { FlexiblePlanSchema, StructuredWorkoutSchema, type StructuredWorkout } from "./structured-workouts.js";
import { allocationTargets, generateFlexiblePlan, planningBudgets, sessionLimit } from "./adaptive-planner.js";
import { resolveWorkoutTargets, workoutEffort } from "./workout-targets.js";

export const GenerationInputSchema = z.object({
  version: z.literal(1), context: PlanningContextSchema, fromDate: LocalDateSchema,
  protectedWorkouts: z.array(StructuredWorkoutSchema).max(168),
}).strict().refine(input => input.fromDate >= input.context.targetWeek.startDate && input.fromDate < input.context.targetWeek.endDate, "Replacement must start inside the target week");
export type GenerationInput = z.infer<typeof GenerationInputSchema>;
export const PlanProposalSchema = z.object({
  version: z.literal(1), explanation: z.string().trim().min(1).max(8000),
  // Only replaceable workouts. Server-owned goals, totals and protected workouts
  // cannot be authored by a generator. Resolved targets are always recomputed.
  workouts: z.array(StructuredWorkoutSchema).max(168),
}).strict();
export type PlanProvider = (input: GenerationInput) => unknown;

export function deterministicPlanProvider(input: GenerationInput) {
  const plan = generateFlexiblePlan(input.context, { preserved: input.protectedWorkouts, fromDate: input.fromDate });
  const protectedIds = new Set(input.protectedWorkouts.map(workout => workout.id));
  return { version: 1, explanation: plan.assumptions.join("\n"), workouts: plan.days.filter(workout => workout.kind === "WORKOUT" && !protectedIds.has(workout.id)) };
}

export function finalizePlanProposal(rawInput: GenerationInput, response: unknown) {
  const input = GenerationInputSchema.parse(rawInput);
  const proposal = PlanProposalSchema.parse(response);
  const { context, protectedWorkouts } = input;
  const protectedIds = new Set(protectedWorkouts.map(workout => workout.id));
  const ids = new Set(protectedIds);
  const workouts = proposal.workouts.map(workout => {
    if (ids.has(workout.id)) throw new Error("Proposal duplicates or replaces a protected workout ID");
    ids.add(workout.id);
    if (workout.date < input.fromDate || workout.date >= context.targetWeek.endDate) throw new Error("Proposal workout is outside the replacement window");
    if (workout.durationMinutes > sessionLimit(context, workout.date, workout.sport)) throw new Error("Proposal violates availability, pool access, or a restriction");
    return resolveWorkoutTargets({ ...workout, effort: workoutEffort(workout) }, context.fitness, context.generatedAt);
  });
  const allWorkouts = [...structuredClone(protectedWorkouts), ...workouts];
  const budgets = planningBudgets(context);
  const limits = allocationTargets(context, protectedWorkouts);
  const assumptions = [proposal.explanation, ...context.dataQuality.notes];
  for (const day of context.availability.days) {
    const retained = protectedWorkouts.filter(workout => workout.date === day.date);
    const proposed = workouts.filter(workout => workout.date === day.date);
    if (proposed.length && (!day.settings || retained.length + proposed.length > day.settings.maxSessions ||
      [...retained, ...proposed].reduce((sum, workout) => sum + workout.durationMinutes, 0) > day.settings.availableMinutes)) throw new Error("Proposal exceeds daily session or time limits");
  }
  const hard = allWorkouts.filter(workout => workout.effort === "HARD");
  for (const workout of workouts.filter(workout => workout.effort === "HARD")) {
    if (hard.length > 2 || hard.some(other => other.id !== workout.id && Math.abs(Date.parse(other.date) - Date.parse(workout.date)) <= 86400000)) throw new Error("Proposal has too many or consecutive hard sessions");
  }
  if (new Set(allWorkouts.map(workout => workout.date)).size === 7 && new Set(protectedWorkouts.map(workout => workout.date)).size < 7) throw new Error("Proposal must leave a rest day");
  for (const sport of PlanSportSchema.options) {
    const retained = protectedWorkouts.filter(workout => workout.sport === sport).reduce((sum, workout) => sum + workout.durationMinutes, 0);
    const total = allWorkouts.filter(workout => workout.sport === sport).reduce((sum, workout) => sum + workout.durationMinutes, 0);
    if (total > Math.max(limits[sport], retained) + 0.001) throw new Error("Proposal exceeds the adjusted sport budget");
    budgets[sport].plannedMinutes = total;
    if (total < budgets[sport].targetMinutes) assumptions.push(`${sport}: planned ${total} min versus goal ${budgets[sport].targetMinutes} min. Availability, adjustments, preserved workouts, and the provider's explanation describe the shortfall. You can adjust your goals separately.`);
    if (retained > limits[sport]) assumptions.push(`${sport}: protected workouts already exceed the adjusted target and were retained.`);
  }
  return FlexiblePlanSchema.parse({ version: 2, timeZone: context.athlete.timeZone,
    weekStart: `${context.targetWeek.startDate}T00:00:00.000Z`, weekEnd: `${context.targetWeek.endDate}T00:00:00.000Z`,
    sourceGeneratedAt: context.generatedAt,
    sourceWeekStarts: context.recentTraining.weeks.filter(week => !week.isCurrentWeek).map(week => `${week.weekStart}T00:00:00.000Z`),
    mode: Object.values(context.goals).some(goal => goal !== null) ? "CUSTOM" : "HISTORY", goals: context.goals,
    budgets, totalMinutes: allWorkouts.reduce((sum, workout) => sum + workout.durationMinutes, 0), assumptions,
    days: context.availability.days.flatMap<z.infer<typeof FlexiblePlanSchema>["days"][number]>(day => {
      const sessions = allWorkouts.filter(workout => workout.date === day.date);
      return sessions.length ? sessions : [{ kind: "REST", date: day.date, title: "Rest day", durationMinutes: 0 }];
    }),
  });
}

export function runPlanGeneration(context: PlanningContext, fromDate: string, protectedWorkouts: StructuredWorkout[], provider: PlanProvider = deterministicPlanProvider) {
  const input = GenerationInputSchema.parse({ version: 1, context, fromDate, protectedWorkouts });
  // Give a provider its own copy so mutations cannot redefine validation inputs.
  return finalizePlanProposal(input, provider(structuredClone(input)));
}
