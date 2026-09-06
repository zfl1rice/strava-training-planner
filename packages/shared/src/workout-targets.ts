import type { PlanningContext } from "./planning-context.js";
import type { StructuredWorkout } from "./structured-workouts.js";

/** Percent pace is percent of seconds per distance: higher means slower. */
export function resolveWorkoutTargets(workout: StructuredWorkout, fitness: PlanningContext["fitness"], generatedAt: string): StructuredWorkout {
  return { ...workout, blocks: workout.blocks.map(block => ({ ...block, segments: block.segments.map(segment => {
    const target = segment.target;
    if (target.metric === "RPE") return { ...segment, resolved: { lower: target.lower, upper: target.upper, unit: "RPE" as const, baseline: null, recordedAt: generatedAt } };
    const runningPace = fitness.definitions.running.thresholdPace;
    const baseline = target.metric === "FTP_PERCENT" ? fitness.effective.cycling.value : target.metric === "MAX_HR_PERCENT" ? fitness.effective.running.value :
      workout.sport === "RUN" ? runningPace?.value ?? null : fitness.effective.swimming.value;
    const unit = target.metric === "FTP_PERCENT" ? "WATTS" as const : target.metric === "MAX_HR_PERCENT" ? "BPM" as const :
      workout.sport === "RUN" ? "SECONDS_PER_KM" as const : fitness.definitions.swimming.paceUnit;
    return { ...segment, resolved: baseline === null ? null : {
      lower: Math.round(baseline * target.lower) / 100, upper: Math.round(baseline * target.upper) / 100,
      unit, baseline, recordedAt: generatedAt,
    } };
  }) })) };
}

export function targetDescription(segment: StructuredWorkout["blocks"][number]["segments"][number]): string {
  const relative = `${segment.target.lower}–${segment.target.upper} ${segment.target.metric === "RPE" ? "RPE" : segment.target.metric === "FTP_PERCENT" ? "% FTP" : segment.target.metric === "MAX_HR_PERCENT" ? "% max HR" : "% threshold pace (time)"}`;
  if (segment.target.metric === "RPE") return relative;
  const resolved = segment.resolved;
  if (!resolved) return `${relative} · baseline unavailable`;
  if (resolved.unit === "RPE") return relative;
  const units = { WATTS: "W", BPM: "bpm", SECONDS_PER_KM: "s/km", SECONDS_PER_100M: "s/100 m", SECONDS_PER_100YD: "s/100 yd" };
  return `${relative} · ${resolved.lower}–${resolved.upper} ${units[resolved.unit]}`;
}

// Conservative classification from the hardest target, independent of provider labels.
// These thresholds are scheduling policy, not a physiological load calculation.
export function workoutEffort(workout: StructuredWorkout): StructuredWorkout["effort"] {
  const targets = workout.blocks.flatMap(block => block.segments.map(segment => segment.target));
  const hard = targets.some(target => target.metric === "RPE" ? target.upper > 6 : target.metric === "FTP_PERCENT" ? target.upper > 90 : target.metric === "MAX_HR_PERCENT" ? target.upper > 85 : target.lower < 105);
  const moderate = targets.some(target => target.metric === "RPE" ? target.upper > 4 : target.metric === "FTP_PERCENT" ? target.upper > 75 : target.metric === "MAX_HR_PERCENT" ? target.upper > 75 : target.lower < 115);
  return hard ? "HARD" : moderate ? "MODERATE" : "EASY";
}
