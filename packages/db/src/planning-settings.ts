import {
  AthleteProfileSchema, EditableRaceSchema, PlanningSettingsMutationSchema, RaceGoalSchema,
  emptyAthleteProfile, type PlanningSettings, type EditableRace,
} from "@pkg/shared";
import type { Prisma } from "@prisma/client";
import { prisma } from "./client.js";

export class PlanningSettingsConflictError extends Error {}
export class PlanningSettingsNotFoundError extends Error {}
export class PlanningSettingsInputError extends Error {}

function storedRace(content: Prisma.JsonValue, date: Date, importance: number) {
  if (!content || typeof content !== "object" || Array.isArray(content)) throw new Error("Invalid race content");
  return RaceGoalSchema.parse({ ...content, date: date.toISOString().slice(0, 10), importance });
}

export async function getPlanningSettings(userId: number, database: Prisma.TransactionClient = prisma): Promise<PlanningSettings> {
  const user = await database.user.findUnique({ where: { id: userId }, select: {
    timeZone: true, athleteProfile: { select: { content: true, updatedAt: true } },
    raceGoals: { orderBy: [{ date: "asc" }, { id: "asc" }], select: { id: true, date: true, importance: true, content: true, updatedAt: true } },
  } });
  if (!user) throw new PlanningSettingsNotFoundError("Athlete not found.");
  const profile = AthleteProfileSchema.parse(user.athleteProfile?.content ?? emptyAthleteProfile());
  return {
    timeZone: user.timeZone, profileUpdatedAt: user.athleteProfile?.updatedAt.toISOString() ?? null,
    baselines: {
      cyclingFtp: profile.fitness.cycling.baseline.manual?.value ?? null,
      runningThresholdPace: profile.fitness.running.thresholdPace?.value ?? null,
      runningMaxHr: profile.fitness.running.baseline.manual?.value ?? null,
      swimThresholdPace: profile.fitness.swimming.baseline.manual?.value ?? null,
      swimPaceUnit: profile.fitness.swimming.paceUnit,
    },
    swimUnitLocked: profile.fitness.swimming.baseline.estimate !== null || profile.fitness.swimming.zones.mode === "CUSTOM",
    availability: profile.availability,
    races: user.raceGoals.map(row => {
      const { demandProfile: _demandProfile, ...race } = storedRace(row.content, row.date, row.importance);
      return { id: row.id, updatedAt: row.updatedAt.toISOString(), race };
    }),
  };
}

// Event-demand changes invalidate the saved profile; editorial/importance/date
// changes retain it. The browser cannot author a trusted demand profile here.
function demandsChanged(previous: EditableRace, next: EditableRace): boolean {
  return previous.eventType !== next.eventType || previous.distanceMeters !== next.distanceMeters ||
    previous.expectedDurationSeconds !== next.expectedDurationSeconds ||
    [...previous.sports].sort().join() !== [...next.sports].sort().join();
}

export async function updatePlanningSettings(userId: number, input: unknown): Promise<PlanningSettings> {
  const change = PlanningSettingsMutationSchema.parse(input);
  return prisma.$transaction(async database => {
    // Serializes editor writes, including creation of the first profile row.
    const locked = await database.$queryRaw<{ id: number }[]>`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
    if (!locked.length) throw new PlanningSettingsNotFoundError("Athlete not found.");
    if (change.section === "PROFILE" || change.section === "AVAILABILITY") {
      const saved = await database.athleteProfile.findUnique({ where: { userId } });
      if ((saved?.updatedAt.toISOString() ?? null) !== change.expectedUpdatedAt) {
        throw new PlanningSettingsConflictError("Your profile or availability changed in another tab. Reload the page before saving again.");
      }
      const profile = AthleteProfileSchema.parse(saved?.content ?? emptyAthleteProfile());
      const updatedAt = new Date(Math.max(Date.now(), (saved?.updatedAt.getTime() ?? 0) + 1));
      if (change.section === "AVAILABILITY") profile.availability = change.availability;
      else {
        const { baselines } = change;
        const swim = profile.fitness.swimming;
        if (baselines.swimPaceUnit !== swim.paceUnit && (swim.baseline.estimate || swim.zones.mode === "CUSTOM")) {
          throw new PlanningSettingsInputError("Swim pace units cannot change while an estimate or custom swim zones use the existing unit.");
        }
        for (const [sport, value] of [
          ["cycling", baselines.cyclingFtp], ["running", baselines.runningMaxHr], ["swimming", baselines.swimThresholdPace],
        ] as const) {
          const baseline = profile.fitness[sport].baseline;
          if (value !== baseline.manual?.value || (sport === "swimming" && baselines.swimPaceUnit !== swim.paceUnit)) {
            baseline.manual = value === null ? null : { value, recordedAt: updatedAt.toISOString(), evidenceIds: [], explanation: null };
          }
        }
        if (baselines.runningThresholdPace !== undefined && baselines.runningThresholdPace !== profile.fitness.running.thresholdPace?.value) {
          profile.fitness.running.thresholdPace = baselines.runningThresholdPace === null ? null : {
            value: baselines.runningThresholdPace, recordedAt: updatedAt.toISOString(), evidenceIds: [], explanation: null,
          };
        }
        swim.paceUnit = baselines.swimPaceUnit;
        await database.user.update({ where: { id: userId }, data: { timeZone: change.timeZone } });
      }
      const content = AthleteProfileSchema.parse(profile);
      await database.athleteProfile.upsert({ where: { userId }, create: { userId, content, updatedAt }, update: { content, updatedAt } });
    } else if (change.section === "RACE_CREATE") {
      const { date, importance, ...fields } = change.race;
      await database.raceGoal.create({ data: { userId, date: new Date(`${date}T00:00:00Z`), importance, content: { ...fields, demandProfile: null } } });
    } else {
      const saved = await database.raceGoal.findFirst({ where: { id: change.id, userId } });
      if (!saved) throw new PlanningSettingsNotFoundError("Race not found.");
      if (saved.updatedAt.toISOString() !== change.expectedUpdatedAt) {
        throw new PlanningSettingsConflictError("This race changed in another tab. Reload the page before saving again.");
      }
      if (change.section === "RACE_DELETE") await database.raceGoal.delete({ where: { id: saved.id } });
      else {
        const previous = storedRace(saved.content, saved.date, saved.importance);
        const next = EditableRaceSchema.parse(change.race);
        const demandProfile = demandsChanged(previous, next) ? null : previous.demandProfile;
        const { date, importance, ...fields } = next;
        await database.raceGoal.update({ where: { id: saved.id }, data: {
          date: new Date(`${date}T00:00:00Z`), importance, content: { ...fields, demandProfile },
          updatedAt: new Date(Math.max(Date.now(), saved.updatedAt.getTime() + 1)),
        } });
      }
    }
    return getPlanningSettings(userId, database);
  }, { timeout: 10000 });
}
