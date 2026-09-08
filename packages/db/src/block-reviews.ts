import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
  BlockMondaySchema, BlockReviewContextSchema, activeBlockForWeek, addCalendarDays, summarizeBlockReviewSports,
  blockReviewRequest, blockWeekPattern, calendarMonday, calendarWorkouts, generateBlockReview, localDateAt,
  weeksBetween, workoutEffort, type BlockReviewer, type BlockReviewEvidence,
} from "@pkg/shared";
import { prisma } from "./client.js";
import { buildPlanningContext } from "./planning-context.js";
import { getDevelopmentBlock, recordBlockReview, StaleBlockGenerationError } from "./development-blocks.js";
import { lockUserTraining } from "./training-lock.js";

/** An explicit boundary: review a started block week for its following week.
 * No raw streams, automatic workout matching, or readiness inference. */
export async function buildBlockReviewContext(userId: number, blockId: number, weekStart: string,
  now = new Date(), database?: Prisma.TransactionClient) {
  BlockMondaySchema.parse(weekStart);
  const read = async (database: Prisma.TransactionClient) => {
    const block = await getDevelopmentBlock(userId, blockId, database);
    if (!block || block.status !== "ACTIVE") throw new Error("Active owned block required for review");
    const weekEnd = addCalendarDays(weekStart, 7);
    const weekly = await buildPlanningContext(userId, { now, weekStart }, database);
    const next = await buildPlanningContext(userId, { now, weekStart: weekEnd }, database);
    const today = localDateAt(now, weekly.athlete.timeZone);
    if (weekStart > today || weekEnd < calendarMonday(today)) throw new Error("Review boundary must affect the current or next week");
    if (weekly.dataQuality.syncInProgress) throw new Error("Finish activity sync before reviewing the block");
    const activeBlock = activeBlockForWeek(block, weekStart);
    if (activeBlock.weekIndex === null) throw new Error("Reviewed week is outside this block");
    const plan = weekly.existingPlans.find(plan => plan.content.weekStart.slice(0, 10) === weekStart);
    const workouts: BlockReviewEvidence["workouts"] = plan ? calendarWorkouts(plan.content).map(workout => {
      const state = plan.workoutStates.find(state => (state.workoutId ?? `${state.date}:${state.templateId}`) === workout.id);
      return { id: workout.id, date: workout.date, sport: workout.sport, title: workout.title,
        durationMinutes: workout.durationMinutes, effort: "blocks" in workout ? workoutEffort(workout) : workout.effort,
        optional: workout.optional, completion: state?.completion ?? "UNREPORTED", locked: state?.locked ?? false,
        feedback: state?.feedback ?? null, achievedTargets: null };
    }) : [];
    const rows = await database.activity.findMany({ where: { userId, startedAt: {
      gte: new Date(`${addCalendarDays(weekStart, -2)}T00:00:00Z`),
      lt: new Date(`${addCalendarDays(weekEnd, 2)}T00:00:00Z`), lte: now,
    } }, select: { id: true, type: true, startedAt: true, durationSeconds: true, distanceMeters: true }, orderBy: [{ startedAt: "asc" }, { id: "asc" }] });
    const activities = rows.map(row => ({ id: row.id, workoutId: null, date: localDateAt(row.startedAt, weekly.athlete.timeZone), sport: row.type,
      durationMinutes: row.durationSeconds / 60, distanceMeters: row.distanceMeters })).filter(row => row.date >= weekStart && row.date < weekEnd);
    const savedBlock = plan && "developmentBlock" in plan.content ? plan.content.developmentBlock : null;
    return BlockReviewContextSchema.parse({ version: 1, athleteId: userId, block: activeBlock,
      sourceFingerprint: createHash("sha256").update(JSON.stringify({ weekly, next, activities })).digest("hex"),
      planningObjective: next.planningObjective, goals: next.goals, effectiveWeekStart: weekEnd,
      remainingWeekPattern: blockWeekPattern(block).slice(weeksBetween(block.proposal.startDate, weekEnd)),
      evidence: { version: 2, generatedAt: now.toISOString(), timeZone: weekly.athlete.timeZone, weekStart, weekEnd, weekComplete: today >= weekEnd,
        plan: plan ? { id: plan.id, updatedAt: plan.updatedAt, blockId: savedBlock?.id ?? null, blockRevision: savedBlock?.revision ?? null } : null,
        workouts, activities: activities.slice(0, 500), activitiesTruncated: activities.length > 500, activityLinkingAvailable: false,
        sports: summarizeBlockReviewSports(workouts, activities, Boolean(plan)),
        restrictions: weekly.restrictions, nextRestrictions: next.restrictions, adjustments: weekly.adjustments, nextAdjustments: next.adjustments,
        nextAvailability: next.availability.days.map(day => ({ date: day.date, settings: day.settings, note: day.note })),
        races: next.races, recentHistory: weekly.trainingHistory?.weeks.slice(0, 3) ?? [],
        notes: [...weekly.dataQuality.notes, "Activities are unlinked; totals do not establish that a particular workout or its numeric targets were completed.",
          "UNREPORTED is unknown completion, not a missed workout. Comments are athlete reports, not established physiological facts.",
          ...(today < weekEnd ? ["The reviewed week is still in progress; do not treat remaining planned sessions as missed."] : []),
          ...(!plan ? ["No saved plan exists for this reviewed week."] : []),
          ...(savedBlock && savedBlock.id !== block.id ? ["The saved week was prescribed under a different block; account for the strategy change."] : []),
        ],
      },
    });
  };
  return database ? read(database) : prisma.$transaction(read, { isolationLevel: "RepeatableRead", timeout: 15000 });
}

/** Direct simulated-review helper retained for scripts/tests.
 * Live application calls must use createOrReuseReviewRun/executeReviewRun.
 */
export async function reviewAndSaveBlockWeek(userId: number, blockId: number, expectedRevision: number,
  weekStart: string, reviewer: BlockReviewer, now?: Date) {
  if (reviewer.source !== "SIMULATED") throw new Error("Live block reviews are evaluation-only until persistent worker dispatch is enabled");
  const capturedAt = now ?? new Date();
  const snapshot = await prisma.$transaction(async database => {
    await lockUserTraining(database, userId);
    const context = await buildBlockReviewContext(userId, blockId, weekStart, capturedAt, database);
    if (context.block.revision !== expectedRevision) throw new StaleBlockGenerationError();
    return context;
  }, { timeout: 15000 });
  const proposal = await generateBlockReview(snapshot, reviewer);
  return prisma.$transaction(async database => {
    await lockUserTraining(database, userId);
    const block = await getDevelopmentBlock(userId, blockId, database);
    if (block?.status !== "ACTIVE" || block.revision !== expectedRevision) throw new StaleBlockGenerationError();
    const current = await buildBlockReviewContext(userId, blockId, weekStart, capturedAt, database);
    if (!isDeepStrictEqual(current, snapshot) || localDateAt(now ?? new Date(), current.evidence.timeZone) !== localDateAt(capturedAt, current.evidence.timeZone)) throw new StaleBlockGenerationError();
    return recordBlockReview(userId, blockId, expectedRevision, blockReviewRequest(snapshot, proposal), capturedAt, {
      database, evidence: snapshot.evidence, source: { provider: reviewer.source, version: "block-review-v3", model: null, responseId: null },
    });
  }, { timeout: 15000 });
}
