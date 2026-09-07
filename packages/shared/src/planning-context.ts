import { PlanningHistorySchema } from "./planning-history.js";
import { StoredPlanSchema, validateStoredPlan } from "./structured-workouts.js";
import { z } from "zod";
import { WeeklyGoalsSchema } from "./planner.js";
import {
  AvailabilitySchema, CapabilitySchema, DayAvailabilitySchema, FitnessProfileSchema,
  PerformanceEvidenceSchema, RaceGoalSchema, RestrictionSchema, WorkoutStatesSchema, TrainingAdjustmentSchema,
} from "./athlete-profile.js";
import { addCalendarDays, LocalDateSchema, TimeZoneSchema, calendarWeekday, localDateAt } from "./planning-dates.js";

export const PlanningObjectiveSchema = z.object({ mode: z.enum(["RACE_TARGETED", "GENERAL_FITNESS"]) }).strict();
export type PlanningObjective = z.infer<typeof PlanningObjectiveSchema>;

// Match the DB context's current/future race filter, using the frozen local date.
export function derivePlanningObjective(races: readonly { goal: { date: string } }[], today: string): PlanningObjective {
  return { mode: races.some(race => race.goal.date >= today) ? "RACE_TARGETED" : "GENERAL_FITNESS" };
}

const Timestamp = z.string().datetime();
const TotalsSchema = z.object({
  activityCount: z.number().int().nonnegative(), durationSeconds: z.number().int().nonnegative(),
  durationMinutes: z.number().nonnegative(), distanceMeters: z.number().nonnegative(),
  missingDistanceCount: z.number().int().nonnegative(),
}).strict();
export const LocalTrainingSummarySchema = z.object({
  timeZone: TimeZoneSchema, generatedAt: Timestamp,
  weeks: z.array(z.object({
    weekStart: LocalDateSchema, weekEnd: LocalDateSchema, isCurrentWeek: z.boolean(),
    run: TotalsSchema, bike: TotalsSchema, swim: TotalsSchema, other: TotalsSchema,
    totalDurationSeconds: z.number().int().nonnegative(), totalDurationMinutes: z.number().nonnegative(),
  }).strict()).length(4),
  completedWeekAverageMinutes: z.number().nonnegative(), completedWeekCount: z.literal(3),
}).strict();

const EffectiveBaselineSchema = z.object({
  value: z.number().finite().positive().nullable(),
  source: z.enum(["MANUAL", "ESTIMATED", "MISSING"]),
  unit: z.enum(["WATTS", "BPM", "SECONDS_PER_100M", "SECONDS_PER_100YD"]),
  recordedAt: Timestamp.nullable(),
}).strict();

export const ExistingContextPlanSchema = z.object({
  id: z.number().int().positive(), updatedAt: Timestamp,
  content: StoredPlanSchema,
  workoutStates: WorkoutStatesSchema,
}).strict().superRefine((plan, context) => {
  try { validateStoredPlan(plan.content); }
  catch { context.addIssue({ code: "custom", message: "Invalid saved plan" }); }
  for (const state of plan.workoutStates) {
    if (!plan.content.days.some(day => day.kind === "WORKOUT" && day.date === state.date && (state.workoutId ? "id" in day && day.id === state.workoutId : day.templateId === state.templateId))) {
      context.addIssue({ code: "custom", message: "Workout state does not identify a workout in the saved plan" });
    }
  }
});

export const PlanningContextSchema = z.object({
  version: z.literal(1), generatedAt: Timestamp,
  athlete: z.object({ id: z.number().int().positive(), timeZone: TimeZoneSchema }).strict(),
  targetWeek: z.object({ startDate: LocalDateSchema, endDate: LocalDateSchema }).strict(),
  goals: WeeklyGoalsSchema,
  fitness: z.object({
    definitions: FitnessProfileSchema,
    effective: z.object({ cycling: EffectiveBaselineSchema, running: EffectiveBaselineSchema, swimming: EffectiveBaselineSchema }).strict(),
  }).strict(),
  performanceProfile: z.object({
    cycling: z.array(CapabilitySchema), running: z.array(CapabilitySchema), swimming: z.array(CapabilitySchema),
    // Bounded evidence: recent observations and evidence cited by the profile.
    // The permanent history remains in Postgres, not in every prompt.
    evidence: z.array(z.object({ id: z.number().int().positive(), observation: PerformanceEvidenceSchema }).strict()),
    historyRecordCount: z.number().int().nonnegative(), evidenceTruncated: z.boolean(),
  }).strict(),
  races: z.array(z.object({ id: z.number().int().positive(), goal: RaceGoalSchema }).strict()),
  // Optional on input for saved snapshots; always derived on output, never an independent setting.
  planningObjective: PlanningObjectiveSchema.optional(),
  recentTraining: LocalTrainingSummarySchema,
  trainingHistory: PlanningHistorySchema.optional(),
  availability: z.object({
    recurring: AvailabilitySchema.innerType().shape.recurring,
    days: z.array(z.object({
      date: LocalDateSchema, source: z.enum(["OVERRIDE", "RECURRING", "DEFAULT", "UNCONFIGURED"]),
      settings: DayAvailabilitySchema.nullable(), note: z.string().nullable(),
    }).strict()).length(7),
  }).strict(),
  restrictions: z.array(RestrictionSchema),
  adjustments: z.array(TrainingAdjustmentSchema).default([]),
  existingPlans: z.array(ExistingContextPlanSchema),
  recentFeedback: z.array(z.object({ date: LocalDateSchema, sport: z.enum(["RUN", "BIKE", "SWIM"]), title: z.string(),
    completion: z.enum(["PLANNED", "COMPLETED", "MODIFIED", "STOPPED"]),
    comment: z.string(), rpe: z.number().int().min(1).max(10).nullable(),
  }).strict()).max(200).default([]),
  feedbackTruncated: z.boolean().default(false),
  dataQuality: z.object({
    lastSuccessfulSyncAt: Timestamp.nullable(), syncInProgress: z.boolean(),
    latestSyncStatus: z.enum(["PENDING", "RUNNING", "SUCCESS", "FAILED", "CANCELLED"]).nullable(),
    notes: z.array(z.string()),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (calendarWeekday(value.targetWeek.startDate) !== 0 ||
    value.targetWeek.endDate !== addCalendarDays(value.targetWeek.startDate, 7)) {
    context.addIssue({ code: "custom", message: "Target must be a Monday-to-Monday calendar week (exclusive end)" });
  }
  value.availability.days.forEach((day, index) => {
    if (day.date !== addCalendarDays(value.targetWeek.startDate, index) ||
      ((day.source === "UNCONFIGURED") !== (day.settings === null))) {
      context.addIssue({ code: "custom", message: "Availability does not cover the target week" });
    }
  });
  if (value.athlete.timeZone !== value.recentTraining.timeZone) {
    context.addIssue({ code: "custom", message: "Training summary timezone differs from athlete timezone" });
  }
}).transform(value => ({ ...value, planningObjective: derivePlanningObjective(value.races, localDateAt(new Date(value.generatedAt), value.athlete.timeZone)) }));
export type PlanningContext = z.infer<typeof PlanningContextSchema>;
