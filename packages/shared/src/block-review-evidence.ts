import { z } from "zod";
import { DayAvailabilitySchema, RaceGoalSchema, RestrictionSchema, TrainingAdjustmentSchema } from "./athlete-profile.js";
import { LocalDateSchema, TimeZoneSchema } from "./planning-dates.js";
import { PlanningHistorySchema } from "./planning-history.js";
import { PlanSportSchema } from "./planner.js";

// Keep v1 readable as historical evidence; its "actual" fields were unlinked week totals.
export const LegacyBlockReviewEvidenceSchema = z.object({
  version: z.literal(1), generatedAt: z.string().datetime(), timeZone: TimeZoneSchema,
  weekStart: LocalDateSchema, weekEnd: LocalDateSchema, weekComplete: z.boolean(),
  plan: z.object({ id: z.number().int().positive(), updatedAt: z.string().datetime(),
    blockId: z.number().int().positive().nullable(), blockRevision: z.number().int().positive().nullable() }).strict().nullable(),
  workouts: z.array(z.object({
    id: z.string(), date: LocalDateSchema, sport: PlanSportSchema, title: z.string(),
    durationMinutes: z.number().nonnegative(), effort: z.enum(["EASY", "MODERATE", "HARD"]), optional: z.boolean(),
    completion: z.enum(["UNREPORTED", "PLANNED", "COMPLETED", "MODIFIED", "STOPPED"]), locked: z.boolean(),
    feedback: z.object({ rpe: z.number().min(1).max(10).nullable(), comment: z.string() }).strict().nullable(),
    // Current database has neither activity links nor measured interval execution.
    achievedTargets: z.null(),
  }).strict()).max(168),
  activityLinkingAvailable: z.literal(false),
  activities: z.array(z.object({ id: z.number().int().positive(), date: LocalDateSchema,
    sport: z.enum(["RUN", "BIKE", "SWIM", "OTHER"]), durationMinutes: z.number().nonnegative(),
    distanceMeters: z.number().nonnegative().nullable() }).strict()).max(500),
  activitiesTruncated: z.boolean(),
  sports: z.array(z.object({ sport: PlanSportSchema, plannedMinutes: z.number().nonnegative().nullable(),
    actualMinutes: z.number().nonnegative(), plannedSessions: z.number().int().nonnegative().nullable(),
    actualSessions: z.number().int().nonnegative(), plannedLongestMinutes: z.number().nonnegative().nullable(),
    actualLongestMinutes: z.number().nonnegative(), reportedCompletedSessions: z.number().int().nonnegative(),
  }).strict()).length(3),
  restrictions: z.array(RestrictionSchema), nextRestrictions: z.array(RestrictionSchema),
  adjustments: z.array(TrainingAdjustmentSchema), nextAdjustments: z.array(TrainingAdjustmentSchema),
  nextAvailability: z.array(z.object({ date: LocalDateSchema, settings: DayAvailabilitySchema.nullable(), note: z.string().nullable() }).strict()).length(7),
  races: z.array(z.object({ id: z.number().int().positive(), goal: RaceGoalSchema }).strict()),
  recentHistory: PlanningHistorySchema.shape.weeks.element.array().max(3),
  notes: z.array(z.string()).max(30),
}).strict();
export const BlockReviewSportEvidenceSchema = z.object({
  sport: PlanSportSchema,
  plannedMinutes: z.number().nonnegative().nullable(), plannedSessions: z.number().int().nonnegative().nullable(),
  plannedLongestMinutes: z.number().nonnegative().nullable(),
  reportedCompletedPlannedMinutes: z.number().nonnegative(), reportedCompletedSessions: z.number().int().nonnegative(),
  recordedActivityMinutes: z.number().nonnegative().nullable(), recordedActivitySessions: z.number().int().nonnegative().nullable(),
  recordedLongestMinutes: z.number().nonnegative().nullable(),
  activityCoverage: z.object({ linkedWorkouts: z.number().int().nonnegative(), plannedWorkouts: z.number().int().nonnegative() }).strict(),
  unlinkedActivityMinutes: z.number().nonnegative(), unlinkedActivitySessions: z.number().int().nonnegative(),
}).strict();

const ReviewActivitySchema = LegacyBlockReviewEvidenceSchema.shape.activities.element.extend({
  // Explicit identity from a trusted source only; never inferred by date/duration.
  workoutId: z.string().min(1).nullable(),
});
const CurrentBlockReviewEvidenceSchema = LegacyBlockReviewEvidenceSchema.extend({
  version: z.literal(2), activityLinkingAvailable: z.boolean(),
  activities: ReviewActivitySchema.array().max(500),
  sports: BlockReviewSportEvidenceSchema.array().length(3),
});
export type BlockReviewEvidence = z.infer<typeof CurrentBlockReviewEvidenceSchema>;
export const BlockReviewEvidenceSchema = CurrentBlockReviewEvidenceSchema.superRefine((evidence, context) => {
  const workouts = new Map(evidence.workouts.map(workout => [workout.id, workout]));
  if (workouts.size !== evidence.workouts.length || new Set(evidence.activities.map(activity => activity.id)).size !== evidence.activities.length) {
    context.addIssue({ code: "custom", message: "Duplicate workout or activity evidence" });
  }
  for (const activity of evidence.activities) {
    if (activity.workoutId !== null && (!evidence.activityLinkingAvailable || workouts.get(activity.workoutId)?.sport !== activity.sport)) {
      context.addIssue({ code: "custom", message: "Activity link must identify a prescribed workout of the same sport" });
    }
  }
  if (evidence.activities.some(activity => activity.date < evidence.weekStart || activity.date >= evidence.weekEnd) ||
    evidence.workouts.some(workout => workout.date < evidence.weekStart || workout.date >= evidence.weekEnd)) {
    context.addIssue({ code: "custom", message: "Review records must belong to the reviewed week" });
  }
  if (!evidence.activitiesTruncated && JSON.stringify(evidence.sports) !== JSON.stringify(summarizeBlockReviewSports(evidence.workouts, evidence.activities, evidence.plan !== null))) {
    context.addIssue({ code: "custom", message: "Review sport evidence must match deterministic source totals and link coverage" });
  }
});
export const StoredBlockReviewEvidenceSchema = z.union([BlockReviewEvidenceSchema, LegacyBlockReviewEvidenceSchema]);

export function summarizeBlockReviewSports(workouts: BlockReviewEvidence["workouts"],
  activities: BlockReviewEvidence["activities"], hasPlan: boolean): BlockReviewEvidence["sports"] {
  return PlanSportSchema.options.map(sport => {
    const prescribed = workouts.filter(workout => workout.sport === sport);
    const completed = prescribed.filter(workout => workout.completion === "COMPLETED");
    const recorded = activities.filter(activity => activity.sport === sport && activity.workoutId !== null && prescribed.some(workout => workout.id === activity.workoutId));
    const unlinked = activities.filter(activity => activity.sport === sport && activity.workoutId === null);
    return { sport, plannedMinutes: hasPlan ? prescribed.reduce((sum, workout) => sum + workout.durationMinutes, 0) : null,
      plannedSessions: hasPlan ? prescribed.length : null,
      plannedLongestMinutes: hasPlan ? Math.max(0, ...prescribed.map(workout => workout.durationMinutes)) : null,
      reportedCompletedPlannedMinutes: completed.reduce((sum, workout) => sum + workout.durationMinutes, 0),
      reportedCompletedSessions: completed.length,
      recordedActivityMinutes: recorded.length ? recorded.reduce((sum, activity) => sum + activity.durationMinutes, 0) : null,
      recordedActivitySessions: recorded.length || null,
      recordedLongestMinutes: recorded.length ? Math.max(...recorded.map(activity => activity.durationMinutes)) : null,
      activityCoverage: { linkedWorkouts: new Set(recorded.map(activity => activity.workoutId)).size, plannedWorkouts: prescribed.length },
      unlinkedActivityMinutes: unlinked.reduce((sum, activity) => sum + activity.durationMinutes, 0), unlinkedActivitySessions: unlinked.length };
  });
}

export const BlockReviewSourceSchema = z.object({
  provider: z.enum(["SIMULATED", "OPENAI"]), version: z.enum(["block-review-v1", "block-review-v2", "block-review-v3"]),
  model: z.string().nullable(), responseId: z.string().nullable(),
}).strict();
