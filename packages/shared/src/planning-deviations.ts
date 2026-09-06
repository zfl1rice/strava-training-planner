import { z } from "zod";
import { PlanSportSchema } from "./planner.js";
import { addCalendarDays } from "./planning-dates.js";
import type { PlanningContext } from "./planning-context.js";
import type { StructuredWorkout } from "./structured-workouts.js";

// Measurements for explanation, never validation failures or physiological advice.
export const PlanningDeviationSchema = z.object({
  type: z.enum(["VOLUME_INCREASE", "VOLUME_DECREASE", "SESSION_FREQUENCY_INCREASE", "LONG_SESSION_INCREASE",
    "INTENSITY_INCREASE", "HARD_SESSION_CLUSTER", "SAME_DAY_HARD_SESSIONS", "GOAL_DIFFERENCE", "NO_REST_DAY"]),
  sport: PlanSportSchema.nullable(), dates: z.array(z.string()),
  measurements: z.record(z.number().finite().nullable()), explanation: z.string(),
}).strict();
export type PlanningDeviation = z.infer<typeof PlanningDeviationSchema>;
export const PlanningAnalysisSchema = z.object({
  deviations: z.array(PlanningDeviationSchema),
  hardSessions: z.object({ total: z.number().int().nonnegative(),
    bySport: z.object({ RUN: z.number(), BIKE: z.number(), SWIM: z.number() }),
    sameDayPairs: z.number().int().nonnegative(), consecutiveDayPairs: z.number().int().nonnegative(),
    recoveryHours: z.null(),
  }).strict(),
}).strict();
const percentChange = (value: number, previous: number) => previous > 0 ? Math.round((value / previous - 1) * 1000) / 10 : null;

export function analyzePlanningDeviations(context: PlanningContext, workouts: StructuredWorkout[], adjustedTargets: Record<"RUN" | "BIKE" | "SWIM", number>) {
  const deviations: PlanningDeviation[] = [];
  const add = (type: PlanningDeviation["type"], sport: PlanningDeviation["sport"], measurements: PlanningDeviation["measurements"], explanation: string, dates: string[] = []) => deviations.push({ type, sport, measurements, explanation, dates });
  const hard = workouts.filter(workout => workout.effort === "HARD");
  for (const sport of PlanSportSchema.options) {
    const proposed = workouts.filter(workout => workout.sport === sport);
    const proposedMinutes = proposed.reduce((sum, workout) => sum + workout.durationMinutes, 0);
    const weeks = context.trainingHistory?.weeks.map(week => week.sports[sport]) ?? [];
    const previous = weeks[0];
    const top = weeks.map(week => week.minutes).filter(minutes => minutes > 0).sort((a, b) => b - a).slice(0, 3).sort((a, b) => a - b);
    const established = top.length ? (top[Math.floor(top.length / 2)]! + top[Math.ceil(top.length / 2) - 1]!) / 2 : null;
    if (previous && proposedMinutes !== previous.minutes) add(proposedMinutes > previous.minutes ? "VOLUME_INCREASE" : "VOLUME_DECREASE", sport,
      { proposedMinutes, previousWeekMinutes: previous.minutes, recentEstablishedMinutes: established, establishedSampleWeeks: top.length,
        changeFromPreviousPercent: percentChange(proposedMinutes, previous.minutes), changeFromEstablishedPercent: established === null ? null : percentChange(proposedMinutes, established) },
      "Recorded volume comparison; percentage is unknown when the comparison volume is zero. Interpret alongside history and feedback.");
    if (previous && proposed.length > previous.sessions) add("SESSION_FREQUENCY_INCREASE", sport,
      { proposedSessions: proposed.length, previousWeekSessions: previous.sessions }, "Session count exceeds the previous recorded week.");
    const longest = Math.max(0, ...proposed.map(workout => workout.durationMinutes));
    if (previous && longest > previous.longestMinutes) add("LONG_SESSION_INCREASE", sport,
      { proposedLongestMinutes: longest, previousLongestMinutes: previous.longestMinutes, recordedWindowLongestMinutes: Math.max(...weeks.map(week => week.longestMinutes)) }, "Longest session exceeds the previous recorded week; longer-window evidence may differ.");
    const hardCount = hard.filter(workout => workout.sport === sport).length;
    if (previous && previous.completedPlanSessions > 0 && hardCount > previous.completedPlanHardSessions) add("INTENSITY_INCREASE", sport,
      { proposedHardSessions: hardCount, previousCompletedPlanHardSessions: previous.completedPlanHardSessions, previousCompletedPlanSessions: previous.completedPlanSessions }, "More hard targets than in completed planned workouts last week. This is incomplete target-based evidence, not measured activity load.");
    if (proposedMinutes !== adjustedTargets[sport]) add("GOAL_DIFFERENCE", sport,
      { savedGoalMinutes: context.goals[sport], adjustedTargetMinutes: adjustedTargets[sport], proposedMinutes, differenceMinutes: proposedMinutes - adjustedTargets[sport] }, "Training targets guide planning; a difference does not invalidate coherent workouts. Saved goals remain unchanged.");
  }
  let sameDayPairs = 0, consecutiveDayPairs = 0;
  const dates = [...new Set(hard.map(workout => workout.date))].sort();
  for (const date of dates) {
    const count = hard.filter(workout => workout.date === date).length;
    if (count > 1) {
      const pairs = count * (count - 1) / 2; sameDayPairs += pairs;
      add("SAME_DAY_HARD_SESSIONS", null, { sessions: count, pairs }, "Hard workouts share a calendar date. Start times and recovery hours are unknown.", [date]);
    }
    const next = addCalendarDays(date, 1);
    const pairs = count * hard.filter(workout => workout.date === next).length;
    if (pairs) { consecutiveDayPairs += pairs; add("HARD_SESSION_CLUSTER", null, { pairs }, "Hard sessions occur on adjacent dates; review the training rationale rather than automatically rejecting them.", [date, next]); }
  }
  if (new Set(workouts.map(workout => workout.date)).size === 7) add("NO_REST_DAY", null, { trainingDays: 7 }, "Every date contains training. Explicit unavailable days remain hard constraints.");
  return PlanningAnalysisSchema.parse({ deviations, hardSessions: { total: hard.length,
    bySport: Object.fromEntries(PlanSportSchema.options.map(sport => [sport, hard.filter(workout => workout.sport === sport).length])),
    sameDayPairs, consecutiveDayPairs, recoveryHours: null } });
}
