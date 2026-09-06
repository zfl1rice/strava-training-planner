import { z } from "zod";
import { PlanSportSchema } from "./planner.js";
import { LocalDateSchema } from "./planning-dates.js";

const Timestamp = z.string().datetime();
const Positive = z.number().finite().positive();
const Text = z.string().trim().min(1).max(2000);

const BaselineValueSchema = z.object({
  value: Positive,
  recordedAt: Timestamp,
  evidenceIds: z.array(z.number().int().positive()).max(100),
  explanation: Text.nullable(),
}).strict();

// Keep the estimate even when a manual value takes precedence. No estimates are
// inferred by the context builder; unsupported baselines remain explicitly null.
export const FitnessBaselineSchema = z.object({
  manual: BaselineValueSchema.nullable(),
  estimate: BaselineValueSchema.nullable(),
}).strict();

const ZoneBoundarySchema = z.object({
  label: z.string().trim().min(1).max(80),
  lower: z.number().finite().nonnegative(),
  upper: Positive.nullable(),
}).strict();
export const ZoneDefinitionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("DERIVED") }).strict(),
  z.object({
    mode: z.literal("CUSTOM"),
    unit: z.enum(["WATTS", "BPM", "SECONDS_PER_100M", "SECONDS_PER_100YD"]),
    // Explicit numeric intervals: lower inclusive, upper exclusive, null = unbounded.
    boundaries: z.array(ZoneBoundarySchema).min(1).max(10),
  }).strict(),
]).superRefine((zones, context) => {
  if (zones.mode !== "CUSTOM") return;
  const labels = new Set<string>();
  zones.boundaries.forEach((zone, index) => {
    const previous = zones.boundaries[index - 1];
    if (labels.has(zone.label) || (zone.upper !== null && zone.upper <= zone.lower) ||
      (previous && (previous.upper === null || zone.lower < previous.upper))) {
      context.addIssue({ code: "custom", message: "Zone labels must be unique and numeric boundaries ordered without overlaps" });
    }
    labels.add(zone.label);
  });
});

const FitnessSportSchema = z.object({
  baseline: FitnessBaselineSchema,
  zones: ZoneDefinitionSchema,
}).strict();
export const FitnessProfileSchema = z.object({
  cycling: FitnessSportSchema,
  running: FitnessSportSchema.extend({ thresholdPace: BaselineValueSchema.nullable().optional() }),
  swimming: FitnessSportSchema.extend({ paceUnit: z.enum(["SECONDS_PER_100M", "SECONDS_PER_100YD"]) }),
}).strict().superRefine((fitness, context) => {
  for (const [key, expectedUnit] of [
    ["cycling", "WATTS"], ["running", "BPM"], ["swimming", fitness.swimming.paceUnit],
  ] as const) {
    const zones = fitness[key].zones;
    if (zones.mode === "CUSTOM" && zones.unit !== expectedUnit) {
      context.addIssue({ code: "custom", path: [key, "zones"], message: "Zone units do not match the sport baseline" });
    }
  }
});

export const CAPABILITIES = {
  BIKE: ["SPRINT", "SHORT_ANAEROBIC", "TWO_TO_FIVE_MINUTE_POWER", "VO2_DURATION", "THRESHOLD", "LONG_ENDURANCE"],
  RUN: ["SPEED", "SHORT_AEROBIC", "FIVE_TEN_K", "THRESHOLD", "LONG_ENDURANCE"],
  SWIM: ["SHORT_SPEED", "THRESHOLD_PACE", "SUSTAINED_ENDURANCE"],
} as const;
export function isCapability(sport: keyof typeof CAPABILITIES, key: string): boolean {
  return (CAPABILITIES[sport] as readonly string[]).includes(key);
}
export const CapabilitySchema = z.object({
  sport: PlanSportSchema,
  key: z.string(),
  score: z.number().finite().min(0).max(100).nullable(),
  confidence: z.enum(["INSUFFICIENT_EVIDENCE", "LOW", "MEDIUM", "HIGH"]),
  trend: z.enum(["UNKNOWN", "IMPROVING", "STABLE", "DECLINING"]),
  evidenceIds: z.array(z.number().int().positive()).max(100),
  updatedAt: Timestamp.nullable(),
  methodVersion: z.string().min(1).max(100).nullable(),
}).strict().superRefine((entry, context) => {
  if (!isCapability(entry.sport, entry.key)) context.addIssue({ code: "custom", message: "Unknown sport capability" });
  if (entry.confidence === "INSUFFICIENT_EVIDENCE" && (entry.score !== null || entry.trend !== "UNKNOWN")) {
    context.addIssue({ code: "custom", message: "Insufficient evidence must not imply a score or trend" });
  }
  if (entry.confidence !== "INSUFFICIENT_EVIDENCE" && (!entry.evidenceIds.length || !entry.updatedAt || !entry.methodVersion)) {
    context.addIssue({ code: "custom", message: "Capability estimates require evidence, date, and calculation version" });
  }
});

export const DayAvailabilitySchema = z.object({
  availableMinutes: z.number().int().min(0).max(1440),
  maxSessions: z.number().int().min(0).max(24),
  allowedSports: z.array(PlanSportSchema).max(3).refine(values => new Set(values).size === values.length),
  poolAccess: z.boolean(),
}).strict().refine(day => day.maxSessions !== 0 || day.availableMinutes === 0,
  "A non-training day must have zero available minutes");

export const AvailabilitySchema = z.object({
  // Monday = 0. Missing days mean unconfigured, not unlimited or a rest day.
  recurring: z.array(z.object({ weekday: z.number().int().min(0).max(6), settings: DayAvailabilitySchema }).strict()).max(7),
  overrides: z.array(z.object({ date: LocalDateSchema, settings: DayAvailabilitySchema, note: Text.nullable() }).strict()).max(366),
}).strict().superRefine((availability, context) => {
  if (new Set(availability.recurring.map(day => day.weekday)).size !== availability.recurring.length ||
      new Set(availability.overrides.map(day => day.date)).size !== availability.overrides.length) {
    context.addIssue({ code: "custom", message: "Duplicate availability day or override date" });
  }
});

export const RestrictionSchema = z.object({
  id: z.string().min(1).max(100),
  sport: PlanSportSchema.nullable(), // null applies to all sports
  kind: z.enum(["NO_TRAINING", "MAX_SESSION_MINUTES", "CONTEXT_ONLY"]),
  maxSessionMinutes: z.number().int().positive().max(1440).nullable(),
  startDate: LocalDateSchema,
  endDate: LocalDateSchema.nullable(), // inclusive, null = until removed
  description: Text,
}).strict().refine(value => (!value.endDate || value.endDate >= value.startDate) &&
  ((value.kind === "MAX_SESSION_MINUTES") === (value.maxSessionMinutes !== null)), "Invalid restriction bounds");

export const TrainingAdjustmentSchema = z.object({
  id: z.string().min(1).max(100), sport: PlanSportSchema.nullable(),
  startDate: LocalDateSchema, endDate: LocalDateSchema,
  volumePercent: z.number().int().min(0).max(200), intensityPercent: z.number().int().min(25).max(175),
  comment: z.string().max(2000),
}).strict().refine(value => value.endDate >= value.startDate, "Adjustment end must follow its start");

export const AthleteProfileSchema = z.object({
  version: z.literal(1),
  fitness: FitnessProfileSchema,
  capabilities: z.array(CapabilitySchema).max(30),
  availability: AvailabilitySchema,
  restrictions: z.array(RestrictionSchema).max(100),
  adjustments: z.array(TrainingAdjustmentSchema).max(100).optional(),
}).strict().superRefine((profile, context) => {
  const keys = profile.capabilities.map(entry => `${entry.sport}:${entry.key}`);
  if (new Set(keys).size !== keys.length || new Set(profile.restrictions.map(entry => entry.id)).size !== profile.restrictions.length) {
    context.addIssue({ code: "custom", message: "Duplicate capability or restriction" });
  }
});
export type AthleteProfile = z.infer<typeof AthleteProfileSchema>;

export function emptyAthleteProfile(): AthleteProfile {
  const sport = () => ({ baseline: { manual: null, estimate: null }, zones: { mode: "DERIVED" as const } });
  return {
    version: 1,
    fitness: { cycling: sport(), running: sport(), swimming: { ...sport(), paceUnit: "SECONDS_PER_100M" } },
    capabilities: [], availability: { recurring: [], overrides: [] }, restrictions: [],
  };
}

export const PerformanceEvidenceSchema = z.object({
  sport: PlanSportSchema,
  metric: z.enum(["POWER_DURATION", "DISTANCE_TIME"]),
  // POWER_DURATION: benchmark seconds, value watts.
  // DISTANCE_TIME: benchmark meters, value elapsed seconds.
  benchmark: Positive,
  value: Positive,
  occurredAt: Timestamp,
  sourceActivityId: z.number().int().positive().nullable(),
  source: z.enum(["MEASURED", "MANUAL", "ESTIMATED"]),
  isPersonalRecord: z.boolean(),
  methodVersion: z.string().min(1).max(100),
}).strict().refine(value => value.metric !== "POWER_DURATION" || value.sport === "BIKE",
  "Power-duration evidence is currently cycling-only");

export const RaceDemandProfileSchema = z.object({
  version: z.literal(1),
  source: z.enum(["CURATED", "USER", "AI"]),
  generatorVersion: z.string().min(1).max(100),
  generatedAt: Timestamp,
  explanation: Text,
  // Normalized to a common 0..100 scale; weights do NOT sum to one.
  weights: z.array(z.object({ sport: PlanSportSchema, capability: z.string(), weight: z.number().finite().min(0).max(100) }).strict()).min(1).max(30),
}).strict().superRefine((profile, context) => {
  const keys = profile.weights.map(value => `${value.sport}:${value.capability}`);
  if (new Set(keys).size !== keys.length || !profile.weights.some(value => value.weight > 0) ||
    profile.weights.some(value => !isCapability(value.sport, value.capability))) {
    context.addIssue({ code: "custom", message: "Demand weights require unique valid capabilities and at least one positive weight" });
  }
});
export const RaceGoalSchema = z.object({
  name: z.string().trim().min(1).max(200),
  eventType: z.string().trim().min(1).max(100),
  sports: z.array(PlanSportSchema).min(1).max(3).refine(values => new Set(values).size === values.length),
  date: LocalDateSchema,
  distanceMeters: Positive.nullable(),
  expectedDurationSeconds: Positive.nullable(),
  performanceGoal: Text.nullable(),
  importance: z.number().int().min(0).max(100),
  demandProfile: RaceDemandProfileSchema.nullable(),
}).strict().refine(race => !race.demandProfile || race.demandProfile.weights.every(weight => race.sports.includes(weight.sport)),
  "Race demands must refer to sports in the event");

export const WorkoutStatesSchema = z.array(z.object({
  date: LocalDateSchema,
  templateId: z.string().min(1),
  workoutId: z.string().min(1).max(100).optional(),
  locked: z.boolean(),
  completion: z.enum(["PLANNED", "COMPLETED", "MODIFIED", "STOPPED"]),
  feedback: z.object({ comment: z.string().max(4000), rpe: z.number().int().min(1).max(10).nullable() }).strict().nullable(),
}).strict()).max(168).refine(states => new Set(states.map(value => value.workoutId ?? value.date)).size === states.length, "Duplicate workout identity");

export type AthleteWorkoutStates = z.infer<typeof WorkoutStatesSchema>;
