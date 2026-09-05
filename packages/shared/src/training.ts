export const TRAINING_WEEK_COUNT = 4;
const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;

export type TrainingActivity = {
  type: "RUN" | "BIKE" | "SWIM" | "OTHER";
  startedAt: Date;
  durationSeconds: number;
  distanceMeters: number | null;
};

export type SportTrainingTotals = {
  activityCount: number;
  durationSeconds: number;
  durationMinutes: number;
  distanceMeters: number;
  missingDistanceCount: number;
};

export type WeeklyTrainingSummary = {
  weekStart: string;
  weekEnd: string;
  isCurrentWeek: boolean;
  run: SportTrainingTotals;
  bike: SportTrainingTotals;
  swim: SportTrainingTotals;
  other: SportTrainingTotals;
  totalDurationSeconds: number;
  totalDurationMinutes: number;
};

export type TrainingSummary = {
  timeZone: "UTC";
  generatedAt: string;
  weeks: WeeklyTrainingSummary[];
  completedWeekAverageMinutes: number;
  completedWeekCount: number;
};

export function mondayUtc(date: Date): Date {
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid training summary date");
  const monday = new Date(date);
  monday.setUTCHours(0, 0, 0, 0);
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  return monday;
}

export function trainingWindowStart(now: Date): Date {
  return new Date(mondayUtc(now).getTime() - (TRAINING_WEEK_COUNT - 1) * WEEK_MS);
}

const emptySport = (): SportTrainingTotals => ({
  activityCount: 0, durationSeconds: 0, durationMinutes: 0, distanceMeters: 0, missingDistanceCount: 0,
});

// Calendar weeks are based on an activity's start time; durations are not split at midnight.
export function summarizeTraining(activities: TrainingActivity[], now = new Date()): TrainingSummary {
  const currentMonday = mondayUtc(now).getTime();
  const oldestMonday = trainingWindowStart(now).getTime();
  const weeks: WeeklyTrainingSummary[] = Array.from({ length: TRAINING_WEEK_COUNT }, (_, index) => {
    const start = currentMonday - index * WEEK_MS;
    return {
      weekStart: new Date(start).toISOString(), weekEnd: new Date(start + WEEK_MS).toISOString(),
      isCurrentWeek: index === 0, run: emptySport(), bike: emptySport(), swim: emptySport(), other: emptySport(),
      totalDurationSeconds: 0, totalDurationMinutes: 0,
    };
  });
  const sportKey = { RUN: "run", BIKE: "bike", SWIM: "swim", OTHER: "other" } as const;
  for (const activity of activities) {
    const timestamp = activity.startedAt.getTime();
    if (timestamp < oldestMonday || timestamp > now.getTime()) continue;
    const index = (currentMonday - mondayUtc(activity.startedAt).getTime()) / WEEK_MS;
    const week = weeks[index];
    if (!week) continue;
    const sport = week[sportKey[activity.type]];
    sport.activityCount++;
    sport.durationSeconds += activity.durationSeconds;
    if (activity.distanceMeters === null) sport.missingDistanceCount++;
    else sport.distanceMeters += activity.distanceMeters;
    week.totalDurationSeconds += activity.durationSeconds;
  }
  for (const week of weeks) {
    for (const key of ["run", "bike", "swim", "other"] as const) {
      week[key].durationMinutes = week[key].durationSeconds / 60;
    }
    week.totalDurationMinutes = week.totalDurationSeconds / 60;
  }
  const completed = weeks.filter(week => !week.isCurrentWeek);
  return {
    timeZone: "UTC", generatedAt: now.toISOString(), weeks,
    completedWeekAverageMinutes: completed.reduce((sum, week) => sum + week.totalDurationMinutes, 0) / completed.length,
    completedWeekCount: completed.length,
  };
}
