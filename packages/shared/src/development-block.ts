import { z } from "zod";
import { StoredBlockReviewEvidenceSchema, BlockReviewSourceSchema, BlockReviewSportEvidenceSchema } from "./block-review-evidence.js";
import { DayAvailabilitySchema, RestrictionSchema, isCapability } from "./athlete-profile.js";
import { PlanSportSchema } from "./planner.js";
import { LocalDateSchema, addCalendarDays, calendarWeekday } from "./planning-dates.js";

export const TrainingPhaseSchema = z.enum(["GENERAL_PREPARATION", "BUILD", "RACE_SPECIFIC", "TAPER", "RECOVERY_TRANSITION"]);
export const BlockWeekRoleSchema = z.enum(["DEVELOPMENT", "RECOVERY", "TAPER", "RACE", "RETURN"]);
export const ProgressionStrategySchema = z.enum(["VOLUME", "LONG_SESSION", "TIME_AT_INTENSITY", "REPETITIONS", "INTERVAL_DURATION", "FREQUENCY", "MAINTAIN"]);
export const BlockDecisionSchema = z.enum(["PROGRESS", "HOLD", "RECOVER_EARLY", "CONTINUE_RECOVERY", "COMPLETE_BLOCK", "REPLAN_BLOCK"]);
export const DevelopmentBlockStatusSchema = z.enum(["ACTIVE", "COMPLETED", "ABORTED"]);
const Rationale = z.string().trim().min(1).max(4000);
const Id = z.number().int().positive();
export const BlockMondaySchema = LocalDateSchema.refine(date => calendarWeekday(date) === 0, "Block weeks start on Monday");
// A bounded document size, not a physiological limit or mandatory cycle length.
export const BlockWeekPatternSchema = z.array(BlockWeekRoleSchema).min(1).max(52);
export const DEFAULT_BLOCK_WEEK_PATTERN = ["DEVELOPMENT", "DEVELOPMENT", "DEVELOPMENT", "RECOVERY"] as const;

export const DevelopmentFocusSchema = z.object({
  sport: PlanSportSchema, capability: z.string(), role: z.enum(["PRIMARY", "SECONDARY", "MAINTENANCE"]),
  progressionStrategy: ProgressionStrategySchema, rationale: Rationale,
}).strict().superRefine((focus, context) => {
  if (!isCapability(focus.sport, focus.capability)) context.addIssue({ code: "custom", message: "Unknown capability for sport" });
  if (focus.role === "MAINTENANCE" && focus.progressionStrategy !== "MAINTAIN") context.addIssue({ code: "custom", message: "Maintenance focus must use MAINTAIN" });
});
export const DevelopmentFocusesSchema = z.array(DevelopmentFocusSchema).min(1).max(12).superRefine((focuses, context) => {
  if (!focuses.some(focus => focus.role === "PRIMARY")) context.addIssue({ code: "custom", message: "A block needs a primary focus" });
  if (new Set(focuses.map(focus => `${focus.sport}:${focus.capability}`)).size !== focuses.length) context.addIssue({ code: "custom", message: "Duplicate focus capability" });
});

// Immutable strategic proposal. End date and plannedWeeks are derived from the pattern.
export const DevelopmentBlockProposalSchema = z.object({
  version: z.literal(1), startDate: BlockMondaySchema, phase: TrainingPhaseSchema,
  focuses: DevelopmentFocusesSchema, weekPattern: BlockWeekPatternSchema,
  raceIds: z.array(Id).max(50), rationale: Rationale,
}).strict().refine(value => new Set(value.raceIds).size === value.raceIds.length, "Duplicate race reference");
export type DevelopmentBlockProposal = z.infer<typeof DevelopmentBlockProposalSchema>;
export type DevelopmentFocus = z.infer<typeof DevelopmentFocusSchema>;
export type TrainingPhase = z.infer<typeof TrainingPhaseSchema>;
export type BlockWeekRole = z.infer<typeof BlockWeekRoleSchema>;
export type BlockDecision = z.infer<typeof BlockDecisionSchema>;

export const FocusActionSchema = z.enum(["PROGRESS", "HOLD", "MAINTAIN"]);
// Existing unique sport/capability key, scoped to the immutable parent block.
export function developmentFocusId(focus: { sport: string; capability: string }): string {
  return `${focus.sport}:${focus.capability}`;
}
export const FocusReferenceGuidanceEntrySchema = z.object({
  focusId: z.string().min(1).max(120), action: FocusActionSchema,
  rationale: z.string().trim().min(1).max(600),
}).strict();
export type FocusReferenceGuidance = z.infer<typeof FocusReferenceGuidanceEntrySchema>[];
// Legacy persisted entries remain readable without rewriting their history.
export const FocusGuidanceEntrySchema = z.object({
  sport: PlanSportSchema, capability: z.string().min(1), action: FocusActionSchema,
  rationale: z.string().trim().min(1).max(600),
}).strict();
export const ResolvedFocusGuidanceEntrySchema = FocusGuidanceEntrySchema.extend({
  focusId: z.string().min(1).max(120), role: z.enum(["PRIMARY", "SECONDARY", "MAINTENANCE"]),
  progressionStrategy: ProgressionStrategySchema,
});
export const FocusGuidanceSchema = z.union([ResolvedFocusGuidanceEntrySchema, FocusGuidanceEntrySchema]).array().min(1).max(12);
export type FocusGuidance = z.infer<typeof FocusGuidanceSchema>;

export function allowedFocusGuidanceMessage(focuses: DevelopmentFocus[]): string {
  return `Allowed focus IDs are exactly: ${focuses.map(developmentFocusId).join(", ")}. Return exactly one guidance item per focus ID. Do not rename, omit, duplicate, or create IDs.`;
}

export function resolveFocusGuidance(focuses: DevelopmentFocus[], guidance: FocusGuidance | FocusReferenceGuidance) {
  const byId = new Map(focuses.map(focus => [developmentFocusId(focus), focus]));
  const ids = guidance.map(entry => "focusId" in entry ? entry.focusId : developmentFocusId(entry));
  const missing = [...byId.keys()].filter(id => !ids.includes(id));
  const unknown = ids.filter(id => !byId.has(id));
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (guidance.length !== focuses.length || missing.length || unknown.length || duplicates.length) {
    throw new Error(`Invalid focus coverage. Missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"}; duplicates: ${duplicates.join(", ") || "none"}. ${allowedFocusGuidanceMessage(focuses)}`);
  }
  return guidance.map((entry, index) => {
    const focusId = ids[index];
    const focus = byId.get(focusId)!;
    if (("sport" in entry && (entry.sport !== focus.sport || entry.capability !== focus.capability)) ||
      ("role" in entry && (entry.role !== focus.role || entry.progressionStrategy !== focus.progressionStrategy))) {
      throw new Error(`Stored focus metadata differs from authoritative focus ${focusId}.`);
    }
    return { focusId, sport: focus.sport, capability: focus.capability, role: focus.role,
      progressionStrategy: focus.progressionStrategy, action: entry.action, rationale: entry.rationale };
  });
}

export function focusGuidanceIssues(focuses: DevelopmentFocus[], decision: BlockDecision, guidance: FocusGuidance | FocusReferenceGuidance): string[] {
  let resolved: ReturnType<typeof resolveFocusGuidance>;
  try { resolved = resolveFocusGuidance(focuses, guidance); }
  catch (error) { return [error instanceof Error ? error.message : "Invalid focus identity"]; }
  const issues: string[] = [];
  for (const entry of resolved) {
    const focus = focuses.find(focus => developmentFocusId(focus) === entry.focusId);
    if (focus?.role === "MAINTENANCE" && entry.action !== "MAINTAIN") issues.push("Maintenance focuses must MAINTAIN; changing their priority requires replanning the block.");
    if (focus && focus.role !== "MAINTENANCE" && entry.action === "MAINTAIN") issues.push("Development focuses use PROGRESS or HOLD; MAINTAIN belongs to maintenance focuses.");
  }
  if (decision === "PROGRESS" && !guidance.some(entry => entry.action === "PROGRESS")) issues.push("Block PROGRESS requires at least one focus progression.");
  if (["RECOVER_EARLY", "CONTINUE_RECOVERY", "COMPLETE_BLOCK", "REPLAN_BLOCK"].includes(decision) && guidance.some(entry => entry.action === "PROGRESS")) issues.push("Recovery and terminal decisions cannot authorize development progression.");
  return issues;
}

export const BlockReviewRequestSchema = z.object({
  reviewedWeekStart: BlockMondaySchema, effectiveWeekStart: BlockMondaySchema,
  decision: BlockDecisionSchema, rationale: Rationale,
  // Optional only for historical/admin reviews; new reviewer proposals require it.
  focusGuidance: FocusGuidanceSchema.optional(),
  // Replaces only the future tail. Allows early/extended recovery, 2+1, 4+1, etc.
  remainingWeekPattern: BlockWeekPatternSchema.optional(),
}).strict().superRefine((review, context) => {
  if (review.effectiveWeekStart <= review.reviewedWeekStart) context.addIssue({ code: "custom", message: "Decision must apply after the reviewed week" });
  if (["COMPLETE_BLOCK", "REPLAN_BLOCK"].includes(review.decision) && review.remainingWeekPattern) context.addIssue({ code: "custom", message: "Terminal decisions cannot change the week pattern" });
  if (["RECOVER_EARLY", "CONTINUE_RECOVERY"].includes(review.decision) && review.remainingWeekPattern?.[0] !== "RECOVERY") context.addIssue({ code: "custom", message: "Recovery decisions need a future pattern starting with RECOVERY" });
});
export type BlockReviewRequest = z.infer<typeof BlockReviewRequestSchema>;

export const BlockResponseSchema = z.object({
  capturedAt: z.string().datetime(),
  sports: z.array(z.object({ sport: PlanSportSchema,
    plannedMinutes: z.number().nonnegative().nullable(), plannedSessions: z.number().int().nonnegative().nullable(),
    activityMinutes: z.number().nonnegative().nullable(), activitySessions: z.number().int().nonnegative().nullable(),
    longestMinutes: z.number().nonnegative().nullable(), reportedCompletedSessions: z.number().int().nonnegative().nullable(),
  }).strict().or(BlockReviewSportEvidenceSchema)).length(3),
  feedback: z.array(z.object({ date: LocalDateSchema, sport: PlanSportSchema, title: z.string(),
    completion: z.enum(["PLANNED", "COMPLETED", "MODIFIED", "STOPPED"]), comment: z.string(),
    rpe: z.number().int().min(1).max(10).nullable(),
  }).strict()).max(20), feedbackTruncated: z.boolean(),
  performanceEvidenceIds: z.array(Id).max(100), notes: z.array(z.string()).max(20),
  restrictions: z.array(RestrictionSchema).max(100),
  availability: z.array(z.object({ date: LocalDateSchema, settings: DayAvailabilitySchema.nullable(), note: z.string().nullable() }).strict()).length(7),
}).strict();
export const BlockReviewSchema = z.object({
  id: Id, revision: Id, createdAt: z.string().datetime(),
  request: BlockReviewRequestSchema, response: BlockResponseSchema,
  evidence: StoredBlockReviewEvidenceSchema.optional(), source: BlockReviewSourceSchema.optional(),
}).strict().superRefine((review, context) => {
  if (review.evidence && (review.evidence.weekStart !== review.request.reviewedWeekStart ||
    review.evidence.weekEnd !== addCalendarDays(review.request.reviewedWeekStart, 7))) {
    context.addIssue({ code: "custom", message: "Review evidence belongs to another week" });
  }
});
export type BlockReview = z.infer<typeof BlockReviewSchema>;
export const DevelopmentBlockSchema = z.object({
  id: Id, userId: Id, revision: Id, status: DevelopmentBlockStatusSchema,
  proposal: DevelopmentBlockProposalSchema, reviews: z.array(BlockReviewSchema),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict().superRefine((block, context) => {
  let pattern = [...block.proposal.weekPattern];
  let revision = 1;
  let effectiveWeek = block.proposal.startDate;
  let terminal = false;
  for (const review of block.reviews) {
    if (review.request.focusGuidance) for (const message of focusGuidanceIssues(block.proposal.focuses, review.request.decision, review.request.focusGuidance)) context.addIssue({ code: "custom", message });
    const reviewedIndex = weeksBetween(block.proposal.startDate, review.request.reviewedWeekStart);
    const effectiveIndex = weeksBetween(block.proposal.startDate, review.request.effectiveWeekStart);
    const endsBlock = ["COMPLETE_BLOCK", "REPLAN_BLOCK"].includes(review.request.decision);
    if (terminal || review.revision <= revision || review.revision > block.revision ||
      review.request.effectiveWeekStart < effectiveWeek || reviewedIndex < 0 || reviewedIndex >= pattern.length ||
      (!endsBlock && effectiveIndex > pattern.length)) context.addIssue({ code: "custom", message: "Invalid block review history" });
    if (review.request.remainingWeekPattern) pattern = [...pattern.slice(0, effectiveIndex), ...review.request.remainingWeekPattern];
    revision = review.revision;
    effectiveWeek = review.request.effectiveWeekStart;
    terminal = endsBlock;
  }
  if (pattern.length > 52 || (terminal && block.status === "ACTIVE")) context.addIssue({ code: "custom", message: "Invalid block lifecycle or pattern length" });
});
export type DevelopmentBlock = z.infer<typeof DevelopmentBlockSchema>;

export function blockWeekPattern(block: DevelopmentBlock): BlockWeekRole[] {
  let pattern = [...block.proposal.weekPattern];
  for (const review of block.reviews) {
    const index = weeksBetween(block.proposal.startDate, review.request.effectiveWeekStart);
    if (review.request.remainingWeekPattern) pattern = [...pattern.slice(0, index), ...review.request.remainingWeekPattern];
  }
  return pattern;
}

export function weeksBetween(start: string, end: string): number {
  return (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / (7 * 86400000);
}

export const ActiveDevelopmentBlockSchema = z.object({
  id: Id, revision: Id, phase: TrainingPhaseSchema, startDate: BlockMondaySchema,
  plannedEndDate: BlockMondaySchema, plannedWeeks: z.number().int().min(1).max(52),
  weekIndex: z.number().int().nonnegative().nullable(), weekRole: BlockWeekRoleSchema.nullable(),
  focuses: DevelopmentFocusesSchema, raceIds: z.array(Id), rationale: Rationale,
  previousReview: BlockReviewSchema.nullable(),
}).strict().superRefine((block, context) => {
  if (block.plannedEndDate !== addCalendarDays(block.startDate, block.plannedWeeks * 7) ||
    (block.weekIndex === null) !== (block.weekRole === null) ||
    (block.weekIndex !== null && block.weekIndex >= block.plannedWeeks)) context.addIssue({ code: "custom", message: "Invalid block week range" });
});
export type ActiveDevelopmentBlock = z.infer<typeof ActiveDevelopmentBlockSchema>;

export function activeBlockForWeek(block: DevelopmentBlock, weekStart: string): ActiveDevelopmentBlock {
  BlockMondaySchema.parse(weekStart);
  const pattern = blockWeekPattern(block);
  const index = weeksBetween(block.proposal.startDate, weekStart);
  const weekRole = pattern[index] ?? null;
  const previous = block.reviews.filter(review => review.request.effectiveWeekStart <= weekStart).at(-1);
  // Detailed evidence stays in review history; weekly planning gets the concise response.
  const previousReview = previous ? (({ evidence: _evidence, ...review }) => review)(previous) : null;
  if (previousReview?.request.focusGuidance) previousReview.request = { ...previousReview.request,
    focusGuidance: resolveFocusGuidance(block.proposal.focuses, previousReview.request.focusGuidance) };
  return ActiveDevelopmentBlockSchema.parse({
    id: block.id, revision: block.revision, phase: block.proposal.phase, startDate: block.proposal.startDate,
    plannedEndDate: addCalendarDays(block.proposal.startDate, pattern.length * 7), plannedWeeks: pattern.length,
    weekIndex: weekRole === null ? null : index, weekRole, focuses: block.proposal.focuses,
    raceIds: block.proposal.raceIds, rationale: block.proposal.rationale,
    previousReview,
  });
}
