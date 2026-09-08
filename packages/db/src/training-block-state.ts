import { addCalendarDays, blockWeekPattern, calendarMonday, localDateAt, PlanSportSchema, type BlockPlanningDirection, type DevelopmentFocus } from "@pkg/shared";
import { prisma } from "./client.js";
import { buildPlanningContext } from "./planning-context.js";
import { createDevelopmentBlock, getActiveDevelopmentBlock, getDevelopmentBlock } from "./development-blocks.js";
import { TrainingBusyError } from "./plan-jobs.js";
import { AthleteProfileSchema, emptyAthleteProfile, TrainingFocusSchema } from "@pkg/shared";
import { lockUserTraining } from "./training-lock.js";

export async function saveTrainingFocus(userId: number, input: unknown, expectedUpdatedAt: string | null) {
  const trainingFocus = TrainingFocusSchema.parse(input);
  await prisma.$transaction(async database => {
    await lockUserTraining(database, userId);
    const row = await database.athleteProfile.findUnique({ where: { userId } });
    if ((row?.updatedAt.toISOString() ?? null) !== expectedUpdatedAt) throw new TrainingBusyError("Settings changed in another tab. Reload before saving focus.");
    const content = { ...AthleteProfileSchema.parse(row?.content ?? emptyAthleteProfile()), trainingFocus };
    const updatedAt = new Date(Math.max(Date.now(), (row?.updatedAt.getTime() ?? 0) + 1));
    await database.athleteProfile.upsert({ where: { userId }, create: { userId, content, updatedAt }, update: { content, updatedAt } });
  });
}

/** Explicit stored goals drive this starter strategy; no inferred fitness scores. */
export async function createInitialTrainingBlock(userId: number, replace = false, now = new Date()) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const startDate = calendarMonday(localDateAt(now, user.timeZone));
  const active = await getActiveDevelopmentBlock(userId);
  if (active && !replace) return active;
  const context = await buildPlanningContext(userId, { now, weekStart: startDate });
  const sports = PlanSportSchema.options.filter(sport => context.goals[sport] !== 0);
  const profileRow = await prisma.athleteProfile.findUnique({ where: { userId } });
  const preference = AthleteProfileSchema.parse(profileRow?.content ?? emptyAthleteProfile()).trainingFocus;
  if (preference) sports.sort((a, b) => preference[b] - preference[a]);
  if (!sports.length) throw new TrainingBusyError("Set a nonzero or automatic sport goal before creating a training block.");
  const races = context.races.filter(race => race.goal.date >= localDateAt(now, user.timeZone))
    .sort((a, b) => b.goal.importance - a.goal.importance || a.goal.date.localeCompare(b.goal.date));
  const race = races[0];
  const primary = sports.find(sport => race?.goal.sports.includes(sport)) ?? sports[0];
  const focuses: DevelopmentFocus[] | undefined = race ? sports.map(sport => {
    const demand = race.goal.demandProfile?.weights.filter(weight => weight.sport === sport).sort((a, b) => b.weight - a.weight)[0];
    const shortRace = race.goal.expectedDurationSeconds !== null && race.goal.expectedDurationSeconds <= 300;
    const capability = demand?.capability ?? (sport === "SWIM" ? "SUSTAINED_ENDURANCE" : shortRace && race.goal.sports.includes(sport)
      ? sport === "RUN" ? "SPEED" : "SHORT_ANAEROBIC" : "LONG_ENDURANCE");
    return { sport, capability, role: sport === primary ? "PRIMARY" : "MAINTENANCE",
      progressionStrategy: sport !== primary ? "MAINTAIN" : ["LONG_ENDURANCE", "SUSTAINED_ENDURANCE"].includes(capability) ? "LONG_SESSION" : "TIME_AT_INTENSITY",
      rationale: sport === primary ? `Initial emphasis for the highest-priority upcoming event: ${race.goal.name}.${preference ? ` Your ${preference[sport]}% preference helps choose emphasis among the event's enabled sports.` : ""} Based on stored event demands, not an inferred weakness.` : `Maintain supporting training while preparing for ${race.goal.name}.${preference ? ` Your ${preference[sport]}% preference remains available for future blocks; this event takes priority.` : ""}` };
  }) : undefined;
  const direction: BlockPlanningDirection = { startDate, phase: race ? "BUILD" : "GENERAL_PREPARATION",
    focuses, raceIds: races.map(value => value.id),
    rationale: race ? `Starter strategy based on ${race.goal.name} and current sport goals. Weekly planning must respect all supplied race dates and restrictions; this is not optimized multi-race periodization.`
      : "General fitness: broad endurance development with supporting sport exposure. Weekly time targets remain desired training goals." };
  if (race && race.goal.date < addCalendarDays(startDate, 28)) {
    const raceWeek = Math.floor((new Date(race.goal.date).getTime() - new Date(startDate).getTime()) / 604800000);
    direction.weekPattern = Array.from({ length: raceWeek + 2 }, (_, index) => index > raceWeek ? "RECOVERY" : index === raceWeek ? "RACE" : index === raceWeek - 1 ? "TAPER" : "DEVELOPMENT");
    if (raceWeek === 0) direction.phase = "RACE_SPECIFIC";
  }
  return createDevelopmentBlock(userId, direction, { now, ...(replace && active ? { mode: "REPLAN", expectedBlock: { id: active.id, revision: active.revision } } : {}) });
}

export async function getTrainingBlockState(userId: number, now = new Date()) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { timeZone: true, athleteProfile: true } });
  const currentMonday = calendarMonday(localDateAt(now, user.timeZone));
  const [active, latest, run, plans] = await Promise.all([
    getActiveDevelopmentBlock(userId),
    prisma.developmentBlock.findFirst({ where: { userId }, orderBy: { id: "desc" }, select: { id: true } }),
    prisma.jobRun.findFirst({ where: { userId, jobType: "REVIEW_BLOCK" }, orderBy: { id: "desc" }, select: { id: true, status: true, error: true } }),
    prisma.weeklyPlan.findMany({ where: { userId, weekStart: { gte: new Date(`${addCalendarDays(currentMonday, -7)}T00:00:00Z`), lte: new Date(`${currentMonday}T00:00:00Z`) } }, orderBy: { weekStart: "asc" }, select: { weekStart: true } }),
  ]);
  const block = active ?? (latest ? await getDevelopmentBlock(userId, latest.id) : null);
  const profile = AthleteProfileSchema.parse(user.athleteProfile?.content ?? emptyAthleteProfile());
  return { block, review: run, trainingFocus: profile.trainingFocus, profileUpdatedAt: user.athleteProfile?.updatedAt.toISOString() ?? null,
    reviewWeeks: plans.map(plan => plan.weekStart.toISOString().slice(0, 10)).filter(week => active && week >= active.proposal.startDate && week < addCalendarDays(active.proposal.startDate, blockWeekPattern(active).length * 7)), currentMonday };
}
