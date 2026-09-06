import { z } from "zod";
import { AvailabilitySchema, RaceGoalSchema, RestrictionSchema, TrainingAdjustmentSchema } from "./athlete-profile.js";
import { PlanningTimestampSchema, TimeZoneSchema } from "./planning-dates.js";

export const ManualBaselinesSchema = z.object({
  cyclingFtp: z.number().finite().positive().nullable(),
  runningThresholdPace: z.number().finite().positive().nullable().optional(),
  runningMaxHr: z.number().int().positive().nullable(),
  swimThresholdPace: z.number().finite().positive().nullable(),
  swimPaceUnit: z.enum(["SECONDS_PER_100M", "SECONDS_PER_100YD"]),
}).strict();
export const EditableRaceSchema = RaceGoalSchema.innerType().omit({ demandProfile: true });

export const PlanningSettingsMutationSchema = z.discriminatedUnion("section", [
  z.object({ section: z.literal("ADJUSTMENTS"), expectedUpdatedAt: PlanningTimestampSchema.nullable(),
    restrictions: z.array(RestrictionSchema).max(100), adjustments: z.array(TrainingAdjustmentSchema).max(100),
  }).strict(),
  z.object({ section: z.literal("PROFILE"), expectedUpdatedAt: PlanningTimestampSchema.nullable(),
    timeZone: TimeZoneSchema, baselines: ManualBaselinesSchema }).strict(),
  z.object({ section: z.literal("AVAILABILITY"), expectedUpdatedAt: PlanningTimestampSchema.nullable(),
    availability: AvailabilitySchema }).strict(),
  z.object({ section: z.literal("RACE_CREATE"), race: EditableRaceSchema }).strict(),
  z.object({ section: z.literal("RACE_UPDATE"), id: z.number().int().positive(),
    expectedUpdatedAt: PlanningTimestampSchema, race: EditableRaceSchema }).strict(),
  z.object({ section: z.literal("RACE_DELETE"), id: z.number().int().positive(),
    expectedUpdatedAt: PlanningTimestampSchema }).strict(),
]);
export type PlanningSettingsMutation = z.infer<typeof PlanningSettingsMutationSchema>;
export type EditableRace = z.infer<typeof EditableRaceSchema>;
export type ManualBaselines = z.infer<typeof ManualBaselinesSchema>;
export type PlanningSettings = {
  profileUpdatedAt: string | null;
  timeZone: string;
  baselines: ManualBaselines;
  swimUnitLocked: boolean;
  availability: z.infer<typeof AvailabilitySchema>;
  restrictions: z.infer<typeof RestrictionSchema>[];
  adjustments: z.infer<typeof TrainingAdjustmentSchema>[];
  races: { id: number; updatedAt: string; race: EditableRace }[];
};

export const WorkoutFeedbackMutationSchema = z.object({
  planId: z.number().int().positive(), workoutId: z.string().min(1).max(150), expectedUpdatedAt: PlanningTimestampSchema,
  completion: z.enum(["PLANNED", "COMPLETED", "MODIFIED", "STOPPED"]), locked: z.boolean(),
  comment: z.string().max(4000), rpe: z.number().int().min(1).max(10).nullable(),
}).strict();

export const GenerationRequestSchema = z.object({
  scope: z.enum(["NEXT_WEEK", "REMAINING_WEEK"]).default("NEXT_WEEK"),
}).strict();
