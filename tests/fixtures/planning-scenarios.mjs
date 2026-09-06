import {
  PlanningContextSchema, GenerationInputSchema, emptyAthleteProfile, defaultDayAvailability,
  summarizeTraining, summarizePlanningHistory, calendarMonday, addCalendarDays, easyWorkout, generateFlexiblePlan,
} from "@pkg/shared";

// Synthetic fixtures: no application records, tokens, network, or exact-plan oracle.
function makeInput(remaining = false) {
  const now = remaining ? "2026-09-10T12:00:00.000Z" : "2026-09-06T12:00:00.000Z";
  const monday = calendarMonday(now.slice(0, 10));
  const startDate = remaining ? monday : addCalendarDays(monday, 7);
  const activities = Array.from({ length: 12 }, (_, week) => ["RUN", "BIKE", "SWIM"].flatMap(type =>
    [1, 3].map(day => ({ type, startedAt: new Date(`${addCalendarDays(monday, -7 * (week + 1) + day)}T12:00:00Z`),
      durationSeconds: ({ RUN: 60, BIKE: 120, SWIM: 30 }[type]) * 60, distanceMeters: null })))).flat();
  const summary = summarizeTraining(activities, new Date(now));
  const definitions = emptyAthleteProfile().fitness;
  definitions.cycling.baseline.manual = { value: 250, recordedAt: now, evidenceIds: [], explanation: "Synthetic FTP" };
  const context = PlanningContextSchema.parse({
    version: 1, generatedAt: now, athlete: { id: 1, timeZone: "UTC" },
    targetWeek: { startDate, endDate: addCalendarDays(startDate, 7) }, goals: { RUN: 120, BIKE: 240, SWIM: 60 },
    fitness: { definitions, effective: {
      cycling: { value: 250, source: "MANUAL", unit: "WATTS", recordedAt: now },
      running: { value: null, source: "MISSING", unit: "BPM", recordedAt: null },
      swimming: { value: null, source: "MISSING", unit: "SECONDS_PER_100M", recordedAt: null },
    } },
    performanceProfile: { cycling: [], running: [], swimming: [], evidence: [], historyRecordCount: 0, evidenceTruncated: false },
    races: [{ id: 1, goal: race("70.3", 90, "2026-11-01", ["RUN", "BIKE", "SWIM"], 18000) }],
    recentTraining: { ...summary, weeks: summary.weeks.map(week => ({ ...week, weekStart: week.weekStart.slice(0, 10), weekEnd: week.weekEnd.slice(0, 10) })) },
    trainingHistory: summarizePlanningHistory(activities, now.slice(0, 10)),
    availability: { recurring: [], days: Array.from({ length: 7 }, (_, day) => ({ date: addCalendarDays(startDate, day), source: "DEFAULT", settings: defaultDayAvailability(), note: null })) },
    restrictions: [], adjustments: [], existingPlans: [], recentFeedback: [], feedbackTruncated: false,
    dataQuality: { lastSuccessfulSyncAt: now, syncInProgress: false, latestSyncStatus: "SUCCESS", notes: ["Synthetic evaluation data; recorded history is not proof of tolerance."] },
  });
  return { version: 1, context, fromDate: remaining ? now.slice(0, 10) : startDate, protectedWorkouts: [] };
}
function race(name, importance, date, sports = ["BIKE"], expectedDurationSeconds = 120) {
  return { name, importance, date, sports, expectedDurationSeconds, eventType: name, distanceMeters: null, performanceGoal: null, demandProfile: null };
}
function adjustment(input, volumePercent) {
  input.context.adjustments = [{ id: "temporary", sport: null, startDate: input.fromDate, endDate: addCalendarDays(input.context.targetWeek.endDate, -1), volumePercent, intensityPercent: 100, comment: "User-requested temporary change" }];
}
function history(input, newestFirst) {
  const { context } = input;
  context.trainingHistory.weeks.forEach((week, index) => {
    week.sports.RUN.minutes = newestFirst[index] ?? 0;
    week.sports.RUN.sessions = week.sports.RUN.minutes ? 2 : 0;
    week.sports.RUN.longestMinutes = week.sports.RUN.minutes / 2;
  });
  context.recentTraining.weeks.filter(week => !week.isCurrentWeek).forEach((week, index) => {
    week.run.durationMinutes = newestFirst[index] ?? 0;
    week.run.durationSeconds = week.run.durationMinutes * 60;
    week.run.activityCount = week.run.durationMinutes ? 2 : 0;
    week.totalDurationMinutes = week.run.durationMinutes + week.bike.durationMinutes + week.swim.durationMinutes;
    week.totalDurationSeconds = week.totalDurationMinutes * 60;
  });
  context.recentTraining.completedWeekAverageMinutes = context.recentTraining.weeks.filter(week => !week.isCurrentWeek).reduce((sum, week) => sum + week.totalDurationMinutes, 0) / 3;
}
function preserve(input, completion, locked) {
  const workout = easyWorkout("protected", input.fromDate, "RUN", 35);
  // Rebuild totals through the deterministic generator with a preserved workout.
  const saved = generateFlexiblePlan(input.context, { preserved: [workout] });
  input.context.existingPlans = [{ id: 1, updatedAt: input.context.generatedAt, content: saved,
    workoutStates: [{ workoutId: workout.id, date: workout.date, templateId: "custom", locked, completion, feedback: { rpe: 5, comment: "Keep this workout" } }] }];
  input.protectedWorkouts = [workout];
}
export function hardWorkout(id, date, sport = "BIKE", minutes = 30) {
  const workout = easyWorkout(id, date, sport, minutes);
  workout.blocks[0].segments[1].target = { metric: "RPE", lower: 7, upper: 8 };
  workout.effort = "HARD";
  return workout;
}

const definitions = [
  ["normal-build", "Normal 70.3 build week", () => {}],
  ["equal-races", "70.3 plus equally important two-minute cycling event", input => input.context.races.push({ id: 2, goal: race("Two-minute event", 90, "2026-10-10") })],
  ["secondary-race", "70.3 dominates a secondary short event", input => input.context.races.push({ id: 2, goal: race("Secondary short event", 15, "2026-10-10") })],
  ["illness-return", "Return toward previously recorded volume after illness", input => { history(input, [110, 180, 185, 190]); input.context.goals.RUN = 180; input.context.recentFeedback = [{ date: "2026-09-01", sport: "RUN", title: "Easy run", completion: "STOPPED", comment: "Illness reduced last week's training", rpe: 8 }]; }],
  ["travel-return", "Return after a travel week", input => { history(input, [40, 180, 185, 190]); input.context.goals.RUN = 180; input.context.dataQuality.notes.push("User reported travel last week."); }],
  ["restricted-weekdays", "Very restricted weekday availability", input => input.context.availability.days.slice(0, 5).forEach(day => { day.source = "RECURRING"; day.settings.availableMinutes = 30; day.settings.maxSessions = 1; })],
  ["adjacent-hard", "Available days force hard sessions close together", input => input.context.availability.days.forEach((day, index) => { if (![1, 2].includes(index)) { day.source = "OVERRIDE"; day.settings = { availableMinutes: 0, maxSessions: 0, allowedSports: [], poolAccess: false }; } })],
  ["same-day-hard", "Two hard workouts may share one date", input => { input.context.availability.days[2].settings.maxSessions = 3; input.context.dataQuality.notes.push("Two sessions on Wednesday are possible; exact recovery hours are not recorded."); }],
  ["no-pool", "No swimming pool available", input => input.context.availability.days.forEach(day => { day.settings.poolAccess = false; })],
  ["no-ftp", "No FTP; running HR and RPE available", input => { input.context.fitness.definitions.cycling.baseline.manual = null; input.context.fitness.effective.cycling = { value: null, source: "MISSING", unit: "WATTS", recordedAt: null }; input.context.fitness.definitions.running.baseline.manual = { value: 190, recordedAt: input.context.generatedAt, evidenceIds: [], explanation: null }; input.context.fitness.effective.running = { value: 190, source: "MANUAL", unit: "BPM", recordedAt: input.context.generatedAt }; }],
  ["volume-decrease", "Large temporary volume decrease", input => adjustment(input, 25)],
  ["volume-increase", "Large temporary volume increase", input => adjustment(input, 175)],
  ["locked-remainder", "Locked workout during remaining-week regeneration", input => preserve(input, "PLANNED", true), true],
  ["completed-remainder", "Completed workout during remaining-week regeneration", input => preserve(input, "COMPLETED", false), true],
  ["run-restriction", "No running; bike and swim allowed", input => { input.context.restrictions = [{ id: "run-pause", sport: "RUN", kind: "NO_TRAINING", startDate: input.fromDate, endDate: null, maxSessionMinutes: null, description: "User instruction: no running" }]; }],
  ["different-race-dates", "Multiple races with different dates", input => input.context.races.push({ id: 2, goal: race("Short event", 90, "2026-09-20") }, { id: 3, goal: race("Later run race", 60, "2026-12-01", ["RUN"], 3600) })],
  ["sparse-history", "Sparse history and insufficient baseline evidence", input => { history(input, [110, 90, 80]); input.context.goals.RUN = 180; input.context.trainingHistory.notes.push("No older run history is recorded; do not infer previous tolerance."); }],
  ["coherent-duration", "235 or 250 coherent bike minutes versus a 240-minute target", input => { input.context.goals = { RUN: 0, BIKE: 240, SWIM: 0 }; }],
];

export function planningScenarios() {
  return definitions.map(([id, description, change, remaining]) => {
    const input = makeInput(remaining); change(input);
    return { id, description, input: GenerationInputSchema.parse(input) };
  });
}
