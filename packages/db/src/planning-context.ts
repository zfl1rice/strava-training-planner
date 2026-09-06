import {
  calendarWorkouts, validateStoredPlan, AthleteProfileSchema, CAPABILITIES, CapabilitySchema, ExistingContextPlanSchema,
  LocalDateSchema, PerformanceEvidenceSchema, PlanningContextSchema, PlanningTimestampSchema, RaceGoalSchema,
  TimeZoneSchema, WorkoutStatesSchema, addCalendarDays, calendarMonday, calendarWeekday,
  emptyAthleteProfile, localDateAt, summarizeTraining,
  type AthleteProfile, type PlanningContext,
} from "@pkg/shared";
import type { Prisma } from "@prisma/client";
import { prisma } from "./client.js";
import { getWeeklyGoals } from "./planner.js";
import { lockUserTraining } from "./training-lock.js";

function profileEvidenceIds(profile: AthleteProfile): number[] {
  return [...new Set([
    ...Object.values(profile.fitness).flatMap(sport => [sport.baseline.manual, sport.baseline.estimate]
      .flatMap(value => value?.evidenceIds ?? [])),
    ...profile.capabilities.flatMap(value => value.evidenceIds),
  ])];
}

async function assertOwnedEvidence(database: Prisma.TransactionClient, userId: number, ids: number[]) {
  if (ids.length && await database.performanceEvidence.count({ where: { userId, id: { in: ids } } }) !== ids.length) {
    throw new Error("Profile references missing evidence or another athlete's evidence");
  }
}

// These are server-side repository functions. Any future HTTP caller must derive
// userId from its authenticated session, never from a submitted profile body.
export async function saveAthleteProfile(userId: number, input: unknown, timeZone: string) {
  const profile = AthleteProfileSchema.parse(input);
  const zone = TimeZoneSchema.parse(timeZone);
  await prisma.$transaction(async database => {
    await lockUserTraining(database, userId);
    await assertOwnedEvidence(database, userId, profileEvidenceIds(profile));
    await database.user.update({ where: { id: userId }, data: { timeZone: zone } });
    await database.athleteProfile.upsert({ where: { userId }, create: { userId, content: profile }, update: { content: profile } });
  });
}

export async function createRaceGoal(userId: number, input: unknown): Promise<number> {
  const goal = RaceGoalSchema.parse(input);
  const { date, importance, ...content } = goal;
  const race = await prisma.raceGoal.create({ data: {
    userId, date: new Date(`${date}T00:00:00Z`), importance, content,
  } });
  return race.id;
}

// Append observations; never overwrite an old PR when a new one arrives.
// Ingestion and deduplication of detected efforts are a later milestone.
export async function recordPerformanceEvidence(userId: number, input: unknown): Promise<number> {
  const evidence = PerformanceEvidenceSchema.parse(input);
  return prisma.$transaction(async database => {
    if (evidence.sourceActivityId !== null && !await database.activity.findFirst({
      where: { id: evidence.sourceActivityId, userId, type: evidence.sport }, select: { id: true },
    })) throw new Error("Evidence activity must belong to this athlete and sport");
    const row = await database.performanceEvidence.create({ data: {
      ...evidence, userId, occurredAt: new Date(evidence.occurredAt),
    } });
    return row.id;
  });
}

export async function saveWorkoutStates(userId: number, planId: number, expectedUpdatedAt: string, input: unknown) {
  const states = WorkoutStatesSchema.parse(input);
  PlanningTimestampSchema.parse(expectedUpdatedAt);
  return prisma.$transaction(async database => {
    await lockUserTraining(database, userId);
    const plan = await database.weeklyPlan.findFirst({ where: { id: planId, userId } });
    if (!plan) throw new Error("Plan not found");
    if (plan.updatedAt.toISOString() !== expectedUpdatedAt) throw new Error("Plan changed; reload before updating workout state");
    ExistingContextPlanSchema.parse({
      id: plan.id, updatedAt: expectedUpdatedAt, content: plan.content, workoutStates: states,
    });
    await database.weeklyPlan.update({ where: { id: plan.id }, data: { workoutStates: states } });
  });
}

function resolveFitness(profile: AthleteProfile): PlanningContext["fitness"] {
  const effective = (key: keyof AthleteProfile["fitness"], unit: "WATTS" | "BPM" | "SECONDS_PER_100M" | "SECONDS_PER_100YD") => {
    const { manual, estimate } = profile.fitness[key].baseline;
    const value = manual ?? estimate;
    return { value: value?.value ?? null, source: manual ? "MANUAL" as const : estimate ? "ESTIMATED" as const : "MISSING" as const,
      recordedAt: value?.recordedAt ?? null, unit };
  };
  return { definitions: profile.fitness, effective: {
    cycling: effective("cycling", "WATTS"), running: effective("running", "BPM"),
    swimming: effective("swimming", profile.fitness.swimming.paceUnit),
  } };
}

/** Read-only context for a target local week. End dates on weeks are exclusive;
 * restriction end dates are inclusive. The default target is next local Monday.
 * RepeatableRead keeps profile, goals, evidence, and plan reads in one snapshot.
 */
export async function buildPlanningContext(
  userId: number, options: { now?: Date; weekStart?: string } = {}, database?: Prisma.TransactionClient,
): Promise<PlanningContext> {
  const now = options.now ?? new Date();
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("Invalid athlete ID");
  PlanningTimestampSchema.parse(now.toISOString());
  const readContext = async (database: Prisma.TransactionClient) => {
    const user = await database.user.findUnique({ where: { id: userId }, select: { id: true, timeZone: true } });
    if (!user) throw new Error("Athlete not found");
    const timeZone = TimeZoneSchema.parse(user.timeZone);
    const today = localDateAt(now, timeZone);
    const currentMonday = calendarMonday(today);
    const startDate = LocalDateSchema.parse(options.weekStart ?? addCalendarDays(currentMonday, 7));
    if (calendarWeekday(startDate) !== 0) throw new Error("Planning week must start on Monday");
    const endDate = addCalendarDays(startDate, 7);
    const oldestDate = addCalendarDays(currentMonday, -21);
    const profileRow = await database.athleteProfile.findUnique({ where: { userId }, select: { content: true } });
    const profile = AthleteProfileSchema.parse(profileRow?.content ?? emptyAthleteProfile());
    const citedIds = profileEvidenceIds(profile);
    await assertOwnedEvidence(database, userId, citedIds);
    const [goals, races, activities, evidence, historyRecordCount, plans, connection, latestSync, unfinishedSync] = await Promise.all([
      getWeeklyGoals(userId, database),
      database.raceGoal.findMany({ where: { userId, date: { gte: new Date(`${today}T00:00:00Z`) } }, orderBy: [{ date: "asc" }, { id: "asc" }] }),
      // Two-day envelope covers all timezone offsets; local-date filtering below
      // gives the exact window and remains correct across DST transitions.
      database.activity.findMany({ where: { userId, startedAt: { gte: new Date(`${addCalendarDays(oldestDate, -2)}T00:00:00Z`), lte: now } },
        select: { type: true, startedAt: true, durationSeconds: true, distanceMeters: true } }),
      database.performanceEvidence.findMany({ where: { userId, occurredAt: { lte: now } }, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: 100 }),
      database.performanceEvidence.count({ where: { userId, occurredAt: { lte: now } } }),
      database.weeklyPlan.findMany({ where: { userId, weekStart: { in: [...new Set([currentMonday, startDate])].map(date => new Date(`${date}T00:00:00Z`)) } }, orderBy: { weekStart: "asc" } }),
      database.stravaConnection.findUnique({ where: { userId }, select: { lastSuccessfulSyncAt: true } }),
      database.jobRun.findFirst({ where: { userId, jobType: "STRAVA_SYNC" }, orderBy: { id: "desc" }, select: { status: true } }),
      database.jobRun.findFirst({ where: { userId, jobType: "STRAVA_SYNC", status: { in: ["PENDING", "RUNNING"] } }, select: { id: true } }),
    ]);
    const feedbackPlans = await database.weeklyPlan.findMany({ where: { userId, weekStart: { gte: new Date(`${addCalendarDays(currentMonday, -28)}T00:00:00Z`), lte: new Date(`${currentMonday}T00:00:00Z`) } }, orderBy: { weekStart: "desc" } });
    const feedback = feedbackPlans.flatMap(plan => {
      const workouts = calendarWorkouts(validateStoredPlan(plan.content));
      return WorkoutStatesSchema.parse(plan.workoutStates).flatMap(state => {
        const workout = workouts.find(value => value.id === (state.workoutId ?? `${state.date}:${state.templateId}`));
        return state.feedback && workout ? [{ date: state.date, sport: workout.sport, title: workout.title,
          completion: state.completion, ...state.feedback }] : [];
      });
    }).sort((a, b) => b.date.localeCompare(a.date));
    const missingCitedIds = citedIds.filter(id => !evidence.some(row => row.id === id));
    if (missingCitedIds.length) evidence.push(...await database.performanceEvidence.findMany({ where: { userId, id: { in: missingCitedIds } } }));
    if (evidence.some(row => row.occurredAt > now)) throw new Error("Profile references evidence after the context timestamp");
    evidence.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || b.id - a.id);

    // Reuse the existing numeric aggregation on synthetic UTC calendar labels.
    // No real activity timestamp is changed or exposed as a synthetic timestamp.
    const summary = summarizeTraining(activities.map(activity => ({
      ...activity, startedAt: new Date(`${localDateAt(activity.startedAt, timeZone)}T00:00:00Z`),
    })), new Date(`${today}T23:59:59.999Z`));
    const capabilities = (sport: keyof typeof CAPABILITIES) => CAPABILITIES[sport].map(key =>
      profile.capabilities.find(value => value.sport === sport && value.key === key) ?? CapabilitySchema.parse({
        sport, key, score: null, confidence: "INSUFFICIENT_EVIDENCE", trend: "UNKNOWN", evidenceIds: [], updatedAt: null, methodVersion: null,
      }));
    const days = Array.from({ length: 7 }, (_, weekday) => {
      const date = addCalendarDays(startDate, weekday);
      const override = profile.availability.overrides.find(value => value.date === date);
      const recurring = profile.availability.recurring.find(value => value.weekday === weekday);
      return { date, source: override ? "OVERRIDE" : recurring ? "RECURRING" : "UNCONFIGURED",
        settings: override?.settings ?? recurring?.settings ?? null, note: override?.note ?? null };
    });
    const notes = ["Existing v1 plans retain their original UTC dates and fixed scheduling policy; they are not rescheduled by this context builder.",
      "Derived zone formulas, capability scoring, and baseline estimation are not calculated in this milestone."];
    if (days.some(day => day.settings === null)) notes.push("Some target days have unconfigured availability; do not assume unlimited training time.");
    if (!connection?.lastSuccessfulSyncAt) notes.push("No successful activity sync is recorded; training history may be incomplete.");
    if (latestSync?.status === "FAILED" || unfinishedSync) notes.push("Activity sync is failed or unfinished; stored history may be partial.");

    return PlanningContextSchema.parse({
      version: 1, generatedAt: now.toISOString(), athlete: user, targetWeek: { startDate, endDate }, goals,
      fitness: resolveFitness(profile),
      performanceProfile: {
        cycling: capabilities("BIKE"), running: capabilities("RUN"), swimming: capabilities("SWIM"),
        evidence: evidence.map(row => ({ id: row.id, observation: {
          sport: row.sport, metric: row.metric, benchmark: row.benchmark, value: row.value, occurredAt: row.occurredAt.toISOString(),
          sourceActivityId: row.sourceActivityId, source: row.source, isPersonalRecord: row.isPersonalRecord, methodVersion: row.methodVersion,
        } })), historyRecordCount, evidenceTruncated: evidence.length < historyRecordCount,
      },
      races: races.map(row => {
        if (!row.content || typeof row.content !== "object" || Array.isArray(row.content)) throw new Error("Invalid race content");
        return { id: row.id, goal: RaceGoalSchema.parse({
          ...row.content, date: row.date.toISOString().slice(0, 10), importance: row.importance,
        }) };
      }),
      recentTraining: { ...summary, timeZone, generatedAt: now.toISOString(), weeks: summary.weeks.map(week => ({
        ...week, weekStart: week.weekStart.slice(0, 10), weekEnd: week.weekEnd.slice(0, 10),
      })) },
      availability: { recurring: profile.availability.recurring, days },
      adjustments: (profile.adjustments ?? []).filter(value => value.startDate < endDate && value.endDate >= startDate),
      restrictions: profile.restrictions.filter(value => value.startDate < endDate && (!value.endDate || value.endDate >= startDate)),
      recentFeedback: feedback.slice(0, 200), feedbackTruncated: feedback.length > 200,
      existingPlans: plans.map(plan => ({ id: plan.id, updatedAt: plan.updatedAt.toISOString(), content: plan.content,
        workoutStates: plan.workoutStates })),
      dataQuality: { lastSuccessfulSyncAt: connection?.lastSuccessfulSyncAt?.toISOString() ?? null,
        syncInProgress: Boolean(unfinishedSync), latestSyncStatus: latestSync?.status ?? null, notes },
    });
  };
  return database ? readContext(database) : prisma.$transaction(readContext, { isolationLevel: "RepeatableRead", timeout: 15000 });
}
