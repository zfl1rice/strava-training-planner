import { isDeepStrictEqual } from "node:util";
import type { Prisma } from "@prisma/client";
import {
  AthleteProfileSchema, BlockPlanningDirectionSchema, BlockResponseSchema, BlockReviewRequestSchema,
  BlockReviewEvidenceSchema, BlockReviewSourceSchema,
  DevelopmentBlockSchema, DevelopmentBlockProposalSchema, PlanSportSchema, RaceGoalSchema, WorkoutStatesSchema,
  addCalendarDays, blockWeekPattern, calendarMonday, calendarWorkouts,
  deterministicBlockPlanner, emptyAthleteProfile, localDateAt, makeBlockPlanningContext,
  validateBlockProposal, validateStoredPlan, weeksBetween, focusGuidanceIssues, resolveFocusGuidance,
  type BlockPlanner, type BlockPlanningDirection, type DevelopmentBlock,
} from "@pkg/shared";
import { prisma } from "./client.js";
import { buildPlanningContext } from "./planning-context.js";
import { lockUserTraining } from "./training-lock.js";
import { TrainingBusyError } from "./plan-jobs.js";

async function requireIdleTraining(userId: number, database: Prisma.TransactionClient) {
  if (await database.jobRun.findFirst({ where: { userId, jobType: "REVIEW_BLOCK", status: { in: ["PENDING", "RUNNING"] } } })) {
    throw new TrainingBusyError("Wait for block review to finish before changing the training block.");
  }
}

type BlockRow = Prisma.DevelopmentBlockGetPayload<{ include: { reviews: true } }>;
const dateLabel = (date: Date) => date.toISOString().slice(0, 10);
const dateValue = (date: string) => new Date(`${date}T00:00:00Z`);

function serializeBlock(row: BlockRow): DevelopmentBlock {
  return DevelopmentBlockSchema.parse({ id: row.id, userId: row.userId, revision: row.revision,
    status: row.status, proposal: row.content, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    reviews: row.reviews.map(review => ({ ...(review.content as object),
      id: review.id, revision: review.revision, createdAt: review.createdAt.toISOString() })),
  });
}

export async function getDevelopmentBlock(userId: number, blockId: number, database: Prisma.TransactionClient = prisma) {
  const row = await database.developmentBlock.findFirst({ where: { id: blockId, userId }, include: { reviews: { orderBy: { revision: "asc" } } } });
  return row ? serializeBlock(row) : null;
}

export async function getActiveDevelopmentBlock(userId: number, database: Prisma.TransactionClient = prisma) {
  const row = await database.developmentBlock.findFirst({ where: { userId, status: "ACTIVE" }, include: { reviews: { orderBy: { revision: "asc" } } } });
  return row ? serializeBlock(row) : null;
}

// Broader than the weekly context: retain recent events for post-race transition,
// all upcoming schedule overrides/restrictions, and three strategic records only.
export async function buildBlockPlanningContext(userId: number, direction: BlockPlanningDirection, now = new Date(), database?: Prisma.TransactionClient) {
  const parsedDirection = BlockPlanningDirectionSchema.parse(direction);
  const read = async (database: Prisma.TransactionClient) => {
    const weekly = await buildPlanningContext(userId, { now, weekStart: parsedDirection.startDate }, database);
    const [history, profileRow, races] = await Promise.all([
      database.developmentBlock.findMany({ where: { userId }, orderBy: { id: "desc" }, take: 3 }),
      database.athleteProfile.findUnique({ where: { userId } }),
      database.raceGoal.findMany({ where: { userId, date: { gte: dateValue(addCalendarDays(localDateAt(now, weekly.athlete.timeZone), -28)) } }, orderBy: [{ date: "asc" }, { id: "asc" }] }),
    ]);
    const context = makeBlockPlanningContext(weekly, parsedDirection, history.map(row => ({ id: row.id, status: row.status,
      proposal: DevelopmentBlockProposalSchema.parse(row.content) })));
    const profile = AthleteProfileSchema.parse(profileRow?.content ?? emptyAthleteProfile());
    return { ...context,
      trainingFocus: profile.trainingFocus,
      races: races.map(row => ({ id: row.id, goal: RaceGoalSchema.parse({ ...(row.content as object), date: dateLabel(row.date), importance: row.importance }) })),
      restrictions: profile.restrictions.filter(value => !value.endDate || value.endDate >= parsedDirection.startDate),
      availabilityOverrides: profile.availability.overrides.filter(value => value.date >= parsedDirection.startDate),
    };
  };
  return database ? read(database) : prisma.$transaction(read, { isolationLevel: "RepeatableRead", timeout: 15000 });
}

export class StaleBlockGenerationError extends Error {
  constructor() { super("Block inputs or strategy changed; reload before retrying"); }
}

/** Server/worker entry point. HTTP callers must obtain userId from the session.
 * Provider work occurs outside the DB transaction; no weekly job is redesigned.
 * IF_NEEDED reuses an active block, including one awaiting an end-of-block review.
 */
export async function createDevelopmentBlock(userId: number, direction: BlockPlanningDirection,
  options: { mode?: "IF_NEEDED" | "REPLAN"; expectedBlock?: { id: number; revision: number }; now?: Date } = {},
  provider: BlockPlanner = deterministicBlockPlanner) {
  const now = options.now ?? new Date();
  const snapshot = await prisma.$transaction(async database => {
    await lockUserTraining(database, userId);
    const active = await getActiveDevelopmentBlock(userId, database);
    if (active && options.mode !== "REPLAN") return { existing: active } as const;
    await requireIdleTraining(userId, database);
    if (options.mode === "REPLAN" && (!active || active.id !== options.expectedBlock?.id || active.revision !== options.expectedBlock.revision)) throw new StaleBlockGenerationError();
    const context = await buildBlockPlanningContext(userId, direction, now, database);
    if (context.dataQuality.syncInProgress) throw new TrainingBusyError("Finish activity sync before planning a block");
    if (direction.startDate < calendarMonday(localDateAt(now, context.athlete.timeZone))) throw new Error("Cannot create a block in a past week");
    return { context, active } as const;
  }, { timeout: 15000 });
  if (snapshot.existing) return snapshot.existing;
  const proposal = validateBlockProposal(snapshot.context, await provider.createBlock(structuredClone(snapshot.context)));
  return prisma.$transaction(async database => {
    await lockUserTraining(database, userId);
    const commitNow = options.now ?? new Date();
    await requireIdleTraining(userId, database);
    const current = await buildBlockPlanningContext(userId, direction, now, database);
    if (localDateAt(commitNow, current.athlete.timeZone) !== localDateAt(now, current.athlete.timeZone) ||
      !isDeepStrictEqual(current, snapshot.context)) throw new StaleBlockGenerationError();
    if (snapshot.active) await database.developmentBlock.update({ where: { id: snapshot.active.id },
      data: { status: "ABORTED", revision: { increment: 1 } } });
    const row = await database.developmentBlock.create({ data: { userId, startDate: dateValue(proposal.startDate),
      plannedEndDate: dateValue(addCalendarDays(proposal.startDate, proposal.weekPattern.length * 7)), phase: proposal.phase, content: proposal }, include: { reviews: true } });
    return serializeBlock(row);
  }, { timeout: 15000 });
}

export async function recordBlockReview(userId: number, blockId: number, expectedRevision: number, raw: unknown, now = new Date(),
  options: { database?: Prisma.TransactionClient; evidence?: unknown; source?: unknown } = {}) {
  const request = BlockReviewRequestSchema.parse(raw);
  const evidence = options.evidence === undefined ? undefined : BlockReviewEvidenceSchema.parse(options.evidence);
  const source = options.source === undefined ? undefined : BlockReviewSourceSchema.parse(options.source);
  const persist = async (database: Prisma.TransactionClient) => {
    await lockUserTraining(database, userId);
    const block = await getDevelopmentBlock(userId, blockId, database);
    if (!block) throw new Error("Block not found");
    if (block.status !== "ACTIVE") throw new Error("Historical blocks cannot be reviewed or rewritten");
    if (block.revision !== expectedRevision) throw new StaleBlockGenerationError();
    if (request.focusGuidance) {
      const issues = focusGuidanceIssues(block.proposal.focuses, request.decision, request.focusGuidance);
      if (issues.length) throw new Error(issues.join(" "));
      request.focusGuidance = resolveFocusGuidance(block.proposal.focuses, request.focusGuidance);
    }
    const weekly = await buildPlanningContext(userId, { now, weekStart: request.reviewedWeekStart }, database);
    if (weekly.dataQuality.syncInProgress) throw new Error("Finish activity sync before reviewing a block");
    const currentMonday = calendarMonday(localDateAt(now, weekly.athlete.timeZone));
    const pattern = blockWeekPattern(block);
    const reviewedIndex = weeksBetween(block.proposal.startDate, request.reviewedWeekStart);
    const effectiveIndex = weeksBetween(block.proposal.startDate, request.effectiveWeekStart);
    const terminal = request.decision === "COMPLETE_BLOCK" || request.decision === "REPLAN_BLOCK";
    if (reviewedIndex < 0 || reviewedIndex >= pattern.length || request.reviewedWeekStart > currentMonday ||
      request.effectiveWeekStart < currentMonday || (!terminal && effectiveIndex > pattern.length) ||
      (block.reviews.at(-1)?.request.effectiveWeekStart ?? block.proposal.startDate) > request.effectiveWeekStart) throw new Error("Review must cover an existing week and affect only current or future weeks without gaps");
    if (request.decision === "CONTINUE_RECOVERY" && pattern[reviewedIndex] !== "RECOVERY") throw new Error("CONTINUE_RECOVERY requires a recovery week");
    if (request.remainingWeekPattern && effectiveIndex + request.remainingWeekPattern.length > 52) throw new Error("Block document exceeds 52 weeks; complete or replan it");
    if (request.remainingWeekPattern?.some(role => role === "TAPER" || role === "RACE") && !block.proposal.raceIds.length) throw new Error("Taper and race weeks require a referenced event");
    const plan = weekly.existingPlans.find(plan => plan.content.weekStart.slice(0, 10) === request.reviewedWeekStart);
    const workouts = plan ? calendarWorkouts(validateStoredPlan(plan.content)) : [];
    const states = plan ? WorkoutStatesSchema.parse(plan.workoutStates) : [];
    const actual = weekly.trainingHistory?.weeks.find(week => week.weekStart === request.reviewedWeekStart);
    const reviewedEnd = addCalendarDays(request.reviewedWeekStart, 7);
    const feedback = evidence ? evidence.workouts.flatMap(workout => !workout.feedback ? [] : [{
      date: workout.date, sport: workout.sport, title: workout.title,
      completion: workout.completion === "UNREPORTED" ? "PLANNED" : workout.completion, ...workout.feedback,
    }]) : weekly.recentFeedback.filter(entry => entry.date >= request.reviewedWeekStart && entry.date < reviewedEnd);
    const response = BlockResponseSchema.parse({ capturedAt: now.toISOString(),
      restrictions: weekly.restrictions,
      availability: weekly.availability.days.map(day => ({ date: day.date, settings: day.settings, note: day.note })),
      sports: evidence ? evidence.sports : PlanSportSchema.options.map(sport => ({ sport,
        plannedMinutes: plan ? workouts.filter(workout => workout.sport === sport).reduce((sum, workout) => sum + workout.durationMinutes, 0) : null,
        plannedSessions: plan ? workouts.filter(workout => workout.sport === sport).length : null,
        activityMinutes: actual?.sports[sport].minutes ?? null,
        activitySessions: actual?.sports[sport].sessions ?? null,
        longestMinutes: actual?.sports[sport].longestMinutes ?? null,
        reportedCompletedSessions: plan ? states.filter(state => state.completion === "COMPLETED" && workouts.some(workout => workout.sport === sport && workout.id === (state.workoutId ?? `${state.date}:${state.templateId}`))).length : null,
      })),
      feedback: feedback.slice(0, 20), feedbackTruncated: feedback.length > 20 || weekly.feedbackTruncated,
      performanceEvidenceIds: weekly.performanceProfile.evidence.filter(entry => {
        const date = localDateAt(new Date(entry.observation.occurredAt), weekly.athlete.timeZone);
        return date >= request.reviewedWeekStart && date < reviewedEnd;
      }).map(entry => entry.id).slice(0, 100),
      notes: ["Decision and rationale were supplied explicitly; comments and performance changes were not inferred.",
        "Activity totals and reported completion are separate evidence; no automatic activity-to-workout matching or target-execution analysis.",
        "Feedback is bounded to the recent four-week window; supplied rationale can describe older disruptions without inferring them.",
        ...(actual || evidence ? [] : ["This week is not in the completed 12-week window; actual training summary is unavailable."]),
        ...(evidence && !evidence.weekComplete ? ["The reviewed week was still in progress at capture; actual totals are partial."] : []),
        ...weekly.dataQuality.notes],
    });
    const revision = block.revision + 1;
    await database.developmentBlockReview.create({ data: { blockId, revision, decision: request.decision,
      reviewedWeekStart: dateValue(request.reviewedWeekStart), effectiveWeekStart: dateValue(request.effectiveWeekStart), content: {
        request, response, ...(evidence ? { evidence } : {}), ...(source ? { source } : {}),
      } } });
    const nextLength = request.remainingWeekPattern ? effectiveIndex + request.remainingWeekPattern.length : pattern.length;
    await database.developmentBlock.update({ where: { id: blockId }, data: {
      revision, status: request.decision === "COMPLETE_BLOCK" ? "COMPLETED" : request.decision === "REPLAN_BLOCK" ? "ABORTED" : "ACTIVE",
      plannedEndDate: dateValue(addCalendarDays(block.proposal.startDate, nextLength * 7)),
    } });
    return (await getDevelopmentBlock(userId, blockId, database))!;
  };
  return options.database ? persist(options.database) : prisma.$transaction(persist, { timeout: 15000 });
}
