import { z } from "zod";
import type { ProviderCallMetadata } from "./provider-call.js";
import { analyzePlanningDeviations } from "./planning-deviations.js";
import { PlanningContextSchema, type PlanningContext } from "./planning-context.js";
import { LocalDateSchema } from "./planning-dates.js";
import { PlanSportSchema } from "./planner.js";
import { FlexiblePlanSchema, StructuredWorkoutSchema, type StructuredWorkout } from "./structured-workouts.js";
import { allocationTargets, generateFlexiblePlan, planningBudgets, sessionLimit } from "./adaptive-planner.js";
import { resolveWorkoutTargets, workoutEffort } from "./workout-targets.js";

export const GenerationInputSchema = z.object({
  version: z.literal(1), context: PlanningContextSchema, fromDate: LocalDateSchema,
  protectedWorkouts: z.array(StructuredWorkoutSchema).max(168),
}).strict().refine(input => input.fromDate >= input.context.targetWeek.startDate && input.fromDate < input.context.targetWeek.endDate, "Replacement must start inside the target week")
  .refine(input => !input.context.blockTransition && input.context.developmentBlock?.weekRole !== null, "Review or replace the block before generating this week");
export type GenerationInput = z.infer<typeof GenerationInputSchema>;
export const PlanProposalSchema = z.object({
  version: z.literal(1), explanation: z.string().trim().min(1).max(8000),
  // Only replaceable workouts. Server-owned goals, totals and protected workouts
  // cannot be authored by a generator. Resolved targets are always recomputed.
  workouts: z.array(StructuredWorkoutSchema).max(168),
}).strict();
export type ProposalIssue = { code: string; path: (string | number)[]; message: string; workoutId?: string };
export type ProposalValidationResult = { attempt: number; valid: boolean; issues: ProposalIssue[] };
export class ProposalValidationError extends Error {
  constructor(public readonly issues: ProposalIssue[]) {
    super(issues.map(issue => issue.message).join("; "));
    this.name = "ProposalValidationError";
  }
}
export class ProposalAttemptsExhaustedError extends ProposalValidationError {
  constructor(issues: ProposalIssue[], public readonly attempts: number) { super(issues); this.name = "ProposalAttemptsExhaustedError"; }
}
export type ProposalAttempt = {
  attempt: number; previousErrors: ProposalIssue[]; previousProposal?: unknown;
  signal?: AbortSignal; reportCall?: (metadata: ProviderCallMetadata) => Promise<void>;
};
export type PlanProvider = (input: GenerationInput, correction: ProposalAttempt) => unknown | Promise<unknown>;
export const MAX_PROPOSAL_ATTEMPTS = 3;

export function deterministicPlanProvider(input: GenerationInput) {
  const plan = generateFlexiblePlan(input.context, { preserved: input.protectedWorkouts, fromDate: input.fromDate });
  const protectedIds = new Set(input.protectedWorkouts.map(workout => workout.id));
  return { version: 1, explanation: plan.assumptions.join("\n"), workouts: plan.days.filter(workout => workout.kind === "WORKOUT" && !protectedIds.has(workout.id)) };
}

export function finalizePlanProposal(rawInput: GenerationInput, response: unknown) {
  const input = GenerationInputSchema.parse(rawInput);
  const parsed = PlanProposalSchema.safeParse(response);
  if (!parsed.success) throw new ProposalValidationError(parsed.error.issues.map(issue => {
    const workouts = response && typeof response === "object" && "workouts" in response ? response.workouts : null;
    const workout = Array.isArray(workouts) && typeof issue.path[1] === "number" ? workouts[issue.path[1]] : null;
    return { code: issue.code === "custom" && issue.params?.code === "LIKELY_FRACTIONAL_PERCENTAGE" ? issue.params.code : "SCHEMA",
      path: issue.path, message: issue.message, ...(typeof workout?.id === "string" ? { workoutId: workout.id } : {}) };
  }));
  const proposal = parsed.data;
  const { context, protectedWorkouts } = input;
  const protectedIds = new Set(protectedWorkouts.map(workout => workout.id));
  const ids = new Set(protectedIds);
  const issues: ProposalIssue[] = [];
  const reject = (code: string, message: string, workout?: StructuredWorkout, index?: number) => issues.push({ code, message,
    path: index === undefined ? ["workouts"] : ["workouts", index], ...(workout ? { workoutId: workout.id } : {}) });
  const workouts = proposal.workouts.map((workout, index) => {
    if (ids.has(workout.id)) reject("PROTECTED_OR_DUPLICATE_ID", "Proposal duplicates or replaces a protected workout ID", workout, index);
    ids.add(workout.id);
    if (workout.date < input.fromDate || workout.date >= context.targetWeek.endDate) reject("DATE_RANGE", "Proposal workout is outside the replacement window", workout, index);
    if (workout.durationMinutes > sessionLimit(context, workout.date, workout.sport)) reject("AVAILABILITY_OR_RESTRICTION", "Proposal violates availability, pool access, or a restriction", workout, index);
    if (context.goals[workout.sport] === 0) reject("EXCLUDED_SPORT", "A zero goal explicitly excludes new workouts for this sport", workout, index);
    const resolved = resolveWorkoutTargets({ ...workout, effort: workoutEffort(workout) }, context.fitness, context.generatedAt);
    resolved.blocks.forEach((block, blockIndex) => block.segments.forEach((segment, segmentIndex) => {
      if (!segment.resolved) issues.push({ code: "UNRESOLVABLE_TARGET", workoutId: workout.id,
        path: ["workouts", index, "blocks", blockIndex, "segments", segmentIndex, "target"],
        message: `No baseline resolves ${segment.target.metric}; use an available baseline or RPE` });
    }));
    return resolved;
  });
  const allWorkouts = [...structuredClone(protectedWorkouts), ...workouts];
  const budgets = planningBudgets(context);
  const adjustedTargets = allocationTargets(context);
  const assumptions = [proposal.explanation, ...context.dataQuality.notes];
  for (const day of context.availability.days) {
    const retained = protectedWorkouts.filter(workout => workout.date === day.date);
    const proposed = workouts.filter(workout => workout.date === day.date);
    if (proposed.length && (!day.settings || retained.length + proposed.length > day.settings.maxSessions ||
      [...retained, ...proposed].reduce((sum, workout) => sum + workout.durationMinutes, 0) > day.settings.availableMinutes)) reject("DAILY_LIMIT", `Proposal exceeds daily session or time limits on ${day.date}`);
  }
  if (issues.length) throw new ProposalValidationError(issues);
  for (const sport of PlanSportSchema.options) {
    const retained = protectedWorkouts.filter(workout => workout.sport === sport).reduce((sum, workout) => sum + workout.durationMinutes, 0);
    const total = allWorkouts.filter(workout => workout.sport === sport).reduce((sum, workout) => sum + workout.durationMinutes, 0);
    budgets[sport].plannedMinutes = total;
    if (total !== budgets[sport].targetMinutes) assumptions.push(`${sport}: planned ${total} min versus goal ${budgets[sport].targetMinutes} min. Availability, adjustments, preserved workouts, and the provider's explanation describe the difference. You can adjust your goals separately.`);
    if (retained > adjustedTargets[sport]) assumptions.push(`${sport}: protected workouts already exceed the adjusted target and were retained.`);
  }
  const result = FlexiblePlanSchema.safeParse({ version: 2, timeZone: context.athlete.timeZone,
    ...(context.developmentBlock ? { developmentBlock: context.developmentBlock } : {}),
    weekStart: `${context.targetWeek.startDate}T00:00:00.000Z`, weekEnd: `${context.targetWeek.endDate}T00:00:00.000Z`,
    sourceGeneratedAt: context.generatedAt,
    sourceWeekStarts: context.recentTraining.weeks.filter(week => !week.isCurrentWeek).map(week => `${week.weekStart}T00:00:00.000Z`),
    mode: Object.values(context.goals).some(goal => goal !== null) ? "CUSTOM" : "HISTORY", goals: context.goals,
    analysis: analyzePlanningDeviations(context, allWorkouts, adjustedTargets),
    budgets, totalMinutes: allWorkouts.reduce((sum, workout) => sum + workout.durationMinutes, 0), assumptions,
    days: context.availability.days.flatMap<z.infer<typeof FlexiblePlanSchema>["days"][number]>(day => {
      const sessions = allWorkouts.filter(workout => workout.date === day.date);
      return sessions.length ? sessions : [{ kind: "REST", date: day.date, title: "Rest day", durationMinutes: 0 }];
    }),
  });
  if (!result.success) throw new ProposalValidationError(result.error.issues.map(issue => ({ code: "PLAN_STRUCTURE", path: issue.path, message: issue.message })));
  return result.data;
}

export function runPlanGeneration(context: PlanningContext, fromDate: string, protectedWorkouts: StructuredWorkout[], provider: (input: GenerationInput) => unknown = deterministicPlanProvider) {
  const input = GenerationInputSchema.parse({ version: 1, context, fromDate, protectedWorkouts });
  // Give a provider its own copy so mutations cannot redefine validation inputs.
  return finalizePlanProposal(input, provider(structuredClone(input)));
}

// Each correction sees the same validated snapshot and only actionable proposal
// errors. Provider/network exceptions escape to the infrastructure retry layer.
export async function generatePlanWithCorrections(rawInput: GenerationInput, provider: PlanProvider = deterministicPlanProvider,
  execution: Pick<ProposalAttempt, "signal" | "reportCall"> & { reportValidation?: (result: ProposalValidationResult) => void | Promise<void> } = {}) {
  const input = GenerationInputSchema.parse(rawInput);
  const { reportValidation, ...providerExecution } = execution;
  let previousErrors: ProposalIssue[] = [];
  let previousProposal: unknown;
  for (let attempt = 1; attempt <= MAX_PROPOSAL_ATTEMPTS; attempt++) {
    execution.signal?.throwIfAborted();
    const response = await provider(structuredClone(input), { ...providerExecution, attempt,
      previousErrors: structuredClone(previousErrors), previousProposal: structuredClone(previousProposal) });
    execution.signal?.throwIfAborted();
    let plan;
    try { plan = finalizePlanProposal(input, response); }
    catch (error) {
      if (!(error instanceof ProposalValidationError)) throw error;
      previousErrors = error.issues;
      previousProposal = response;
      await reportValidation?.({ attempt, valid: false, issues: structuredClone(previousErrors) });
      continue;
    }
    await reportValidation?.({ attempt, valid: true, issues: [] });
    return plan;
  }
  throw new ProposalAttemptsExhaustedError(previousErrors, MAX_PROPOSAL_ATTEMPTS);
}
