import { PlanningAnalysisSchema } from "./planning-deviations.js";
import { ActiveDevelopmentBlockSchema } from "./development-block.js";
import { PlanProvenanceSchema } from "./provider-call.js";
import { targetDescription } from "./workout-targets.js";
import { z } from "zod";
import { PlanSportSchema, WeeklyPlanSchema, validateWeeklyPlan, type WeeklyPlan } from "./planner.js";
import { LocalDateSchema, TimeZoneSchema, addCalendarDays, calendarWeekday } from "./planning-dates.js";

export const WorkoutTargetSchema = z.object({
  metric: z.enum(["RPE", "FTP_PERCENT", "MAX_HR_PERCENT", "THRESHOLD_PACE_PERCENT"])
    .describe("All *_PERCENT metrics use percentage points: 88 means 88%, never 0.88. Threshold pace scales time per distance, so higher means slower."),
  lower: z.number().finite().positive().describe("Lower target: RPE or percentage points (e.g. 88 for 88%)."),
  upper: z.number().finite().positive().describe("Upper target: RPE or percentage points (e.g. 92 for 92%)."),
}).strict().superRefine((value, context) => {
  if (value.lower > value.upper || value.upper > (value.metric === "RPE" ? 10 : value.metric === "MAX_HR_PERCENT" ? 100 : 300)) {
    context.addIssue({ code: "custom", message: "Invalid target range" });
  }
  if (value.metric !== "RPE") for (const bound of ["lower", "upper"] as const) {
    // Representation guard, not a physiological floor. Do not guess by multiplying.
    if (value[bound] > 0 && value[bound] <= 2) context.addIssue({ code: "custom", path: [bound],
      params: { code: "LIKELY_FRACTIONAL_PERCENTAGE" },
      message: `${value.metric} uses percentage points: use 88 for 88%, not 0.88. Values in (0, 2] are rejected as likely fractional encoding; no automatic conversion is applied.`,
    });
  }
});

export const WorkoutSegmentSchema = z.object({
  label: z.string().trim().min(1).max(100),
  seconds: z.number().int().positive().max(86400),
  instructions: z.string().trim().min(1).max(2000),
  target: WorkoutTargetSchema,
  resolved: z.object({ lower: z.number().finite().positive(), upper: z.number().finite().positive(),
    unit: z.enum(["WATTS", "BPM", "SECONDS_PER_KM", "SECONDS_PER_100M", "SECONDS_PER_100YD", "RPE"]),
    baseline: z.number().finite().positive().nullable(), recordedAt: z.string().datetime(),
  }).strict().nullable().optional(),
}).strict();
export const WorkoutBlockSchema = z.object({
  repeat: z.number().int().min(1).max(100),
  segments: z.array(WorkoutSegmentSchema).min(1).max(20),
}).strict();
export const StructuredWorkoutSchema = z.object({
  kind: z.literal("WORKOUT"), id: z.string().min(1).max(100), date: LocalDateSchema,
  templateId: z.string().min(1).max(100).nullable(), sport: PlanSportSchema,
  title: z.string().trim().min(1).max(200), effort: z.enum(["EASY", "MODERATE", "HARD"]),
  explanation: z.string().max(4000), optional: z.boolean(),
  durationMinutes: z.number().finite().positive().max(1440),
  blocks: z.array(WorkoutBlockSchema).min(1).max(50),
}).strict().superRefine((workout, context) => {
  const seconds = workout.blocks.reduce((total, block) => total + block.repeat * block.segments.reduce((sum, segment) => sum + segment.seconds, 0), 0);
  if (Math.abs(seconds - workout.durationMinutes * 60) > 0.001) context.addIssue({ code: "custom", message: "Workout duration must equal its interval blocks" });
  if (workout.blocks.reduce((sum, block) => sum + block.repeat * block.segments.length, 0) > 1000) context.addIssue({ code: "custom", message: "Too many expanded workout segments" });
  for (const segment of workout.blocks.flatMap(block => block.segments)) {
    if ((segment.target.metric === "FTP_PERCENT" && workout.sport !== "BIKE") ||
      (segment.target.metric === "MAX_HR_PERCENT" && workout.sport !== "RUN") ||
      (segment.target.metric === "THRESHOLD_PACE_PERCENT" && workout.sport === "BIKE")) context.addIssue({ code: "custom", message: "Target metric does not match workout sport" });
  }
});
export type StructuredWorkout = z.infer<typeof StructuredWorkoutSchema>;

export const FlexiblePlanSchema = WeeklyPlanSchema.extend({
  version: z.literal(2), timeZone: TimeZoneSchema,
  analysis: PlanningAnalysisSchema.optional(),
  generation: PlanProvenanceSchema.optional(),
  developmentBlock: ActiveDevelopmentBlockSchema.optional(),
  totalMinutes: z.number().finite().nonnegative(),
  budgets: z.object({ RUN: WeeklyPlanSchema.shape.budgets.shape.RUN.extend({ plannedMinutes: z.number().finite().nonnegative() }),
    BIKE: WeeklyPlanSchema.shape.budgets.shape.BIKE.extend({ plannedMinutes: z.number().finite().nonnegative() }),
    SWIM: WeeklyPlanSchema.shape.budgets.shape.SWIM.extend({ plannedMinutes: z.number().finite().nonnegative() }),
  }).strict(),
  days: z.array(z.union([StructuredWorkoutSchema, z.object({
    kind: z.literal("REST"), date: LocalDateSchema, title: z.literal("Rest day"), durationMinutes: z.literal(0),
  }).strict()])).max(168),
}).strict().superRefine((plan, context) => {
  const start = plan.weekStart.slice(0, 10);
  const dates = Array.from({ length: 7 }, (_, i) => addCalendarDays(start, i));
  if (calendarWeekday(start) !== 0 || plan.weekStart !== `${start}T00:00:00.000Z` || plan.weekEnd !== `${addCalendarDays(start, 7)}T00:00:00.000Z`) context.addIssue({ code: "custom", message: "Invalid local calendar week labels" });
  const ids = new Set<string>();
  for (const day of plan.days) {
    if (!dates.includes(day.date)) context.addIssue({ code: "custom", message: "Workout outside plan week" });
    if (day.kind === "WORKOUT") {
      if (ids.has(day.id)) context.addIssue({ code: "custom", message: "Duplicate workout ID" });
      ids.add(day.id);
    }
  }
  for (const date of dates) {
    const entries = plan.days.filter(day => day.date === date);
    if (!entries.length || (entries.some(day => day.kind === "REST") && entries.length !== 1)) context.addIssue({ code: "custom", message: "Each date needs workouts or one rest entry" });
  }
  for (const sport of PlanSportSchema.options) {
    const minutes = plan.days.reduce((sum, day) => sum + (day.kind === "WORKOUT" && day.sport === sport ? day.durationMinutes : 0), 0);
    if (Math.abs(minutes - plan.budgets[sport].plannedMinutes) > 0.001) context.addIssue({ code: "custom", message: "Incorrect sport total" });
  }
  if (Math.abs(plan.totalMinutes - plan.days.reduce((sum, day) => sum + day.durationMinutes, 0)) > 0.001) context.addIssue({ code: "custom", message: "Incorrect plan total" });
});
export type FlexiblePlan = z.infer<typeof FlexiblePlanSchema>;
export const StoredPlanSchema = z.union([WeeklyPlanSchema, FlexiblePlanSchema]);
export type StoredPlan = WeeklyPlan | FlexiblePlan;
export function validateStoredPlan(input: unknown): StoredPlan {
  return (input as { version?: number })?.version === 2 ? FlexiblePlanSchema.parse(input) : validateWeeklyPlan(input);
}

// A presentation adapter lets old snapshots keep their original data and layout.
export function calendarWorkouts(plan: StoredPlan) {
  return plan.days.flatMap(day => day.kind === "REST" ? [] : [{
    ...day, id: "id" in day ? day.id : `${day.date}:${day.templateId}`,
    steps: "steps" in day ? day.steps : day.blocks.flatMap(block => Array.from({ length: block.repeat }, (_, index) =>
      block.segments.map(segment => ({ label: block.repeat > 1 ? `${segment.label} (${index + 1}/${block.repeat})` : segment.label,
        minutes: segment.seconds / 60, instructions: `${segment.instructions} Target: ${targetDescription(segment)}`,
      })))).flat(),
  }]);
}
