import { BlockReviewContextSchema, addCalendarDays, summarizeBlockReviewSports, developmentFocusId } from "@pkg/shared";
import { planningScenarios } from "./planning-scenarios.mjs";

// Keep previously documented commands usable without duplicating evaluations.
export const blockReviewScenarioAliases = {
  "primary-progress-secondary-hold": "primary-success-secondary-poor",
  "high-rpe": "high-rpe-hold",
  "poor-sessions-fatigue": "recover-early",
  "new-important-race": "replan-new-race",
};

export const blockReviewBoundaryScenarioIds = [
  "primary-success-secondary-poor", "high-rpe-hold", "recover-early",
  "continue-recovery", "complete-block", "replan-new-race",
];

function prescribeRecoveryWeek(context) {
  context.block.weekRole = "RECOVERY";
  context.evidence.workouts.forEach(workout => {
    workout.durationMinutes /= 2;
    workout.effort = "EASY";
    workout.title = `Easy ${workout.sport.toLowerCase()} recovery session`;
    workout.feedback = { rpe: 3, comment: "Marked the reduced easy session completed." };
  });
  context.evidence.notes.push("This week's saved prescription reduced minutes from the preceding development weeks and contained only easy sessions.");
}

const scenarios = [
  ["successful-run-block", "PROGRESS", "Reported completion and RPE support a small primary long-session progression; recorded execution and recovery remain unknown.", context => { context.evidence.activities = []; }],
  ["both-focuses-progress", "PROGRESS", "Specific athlete reports support a small primary and secondary progression together; recorded interval execution remains unknown.", context => {
    context.evidence.workouts[0].feedback = { rpe: 3, comment: "The long run felt controlled throughout and I would welcome a small extension." };
    context.evidence.workouts[1].feedback = { rpe: 6, comment: "All bike repeats felt controlled, including the last one; a small increase in work time feels manageable alongside the run focus." };
  }],
  ["primary-success-secondary-poor", "PROGRESS", "Reported run completion and ordinary RPE support primary progression; hold the difficult secondary bike stimulus. A single struggling bike session does not establish a need to change the strategy or recover the whole week. Recorded execution remains unknown.", context => {
    context.evidence.workouts[1].completion = "STOPPED";
    context.evidence.workouts[1].feedback = { rpe: 9, comment: "Stopped the last bike repeat; the run felt normal." };
  }],
  ["partially-linked", "PROGRESS", "Some recorded running supports context, while unlinked sessions remain unverified.", context => {
    context.evidence.activityLinkingAvailable = true;
    context.evidence.activities[0].workoutId = context.evidence.workouts[0].id;
    context.evidence.activities[0].durationMinutes = 58;
  }],
  ["fully-linked", "PROGRESS", "All prescribed sessions have linked activity durations; target execution and measured recovery remain unavailable.", context => {
    context.evidence.activityLinkingAvailable = true;
    context.evidence.activities.forEach((activity, index) => { activity.workoutId = context.evidence.workouts[index].id; });
    context.evidence.activities[0].durationMinutes = 58;
  }],
  ["high-rpe-hold", "HOLD", "One completed easy long run had unusually high reported effort. Pause progression without inferring fitness loss or a whole-week recovery need; recorded execution remains unknown.", context => { context.evidence.workouts[0].feedback = { rpe: 9, comment: "This easy run felt unusually hard. I cannot explain why; the other sessions felt ordinary." }; }],
  ["stopped-key-session", "HOLD", "The primary run stopped early; the cause is uncertain, so progression is not yet justified.", context => { context.evidence.workouts[0].completion = "STOPPED"; context.evidence.activities[0].durationMinutes = 20; }],
  ["recover-early", "RECOVER_EARLY", "Repeated stopped sessions and significant athlete-reported fatigue support replacing the next development week with recovery. No medical cause or recorded target execution is established.", context => {
    context.evidence.workouts.filter(workout => workout.sport === "RUN").forEach(workout => { workout.completion = "STOPPED"; workout.feedback = { rpe: 9, comment: "I stopped this run because I felt unusually exhausted; this has persisted across several days." }; });
    context.evidence.workouts[1].completion = "MODIFIED";
    context.evidence.workouts[1].feedback = { rpe: 9, comment: "Cut the bike repeats short too; even ordinary training has felt draining this week." };
    context.evidence.activities.filter(activity => activity.sport === "RUN").forEach(activity => { activity.durationMinutes = 20; });
  }],
  ["continue-recovery", "CONTINUE_RECOVERY", "Despite following a reduced prescription, the athlete still reports high effort and persistent fatigue. Continue recovery rather than resume development on the calendar alone; duration and recovery are not independently verified.", context => {
    prescribeRecoveryWeek(context);
    context.evidence.workouts[0].feedback = { rpe: 8, comment: "Even this shorter easy run felt unusually hard; I still feel run down." };
    context.evidence.workouts[3].feedback = { rpe: 7, comment: "The later short run still felt draining despite doing less training this week." };
  }],
  ["recovery-resume", "PROGRESS", "Successful recovery and an explicit ready-to-resume report support returning to development.", context => { context.block.weekRole = "RECOVERY"; context.evidence.workouts[0].feedback.comment = "Recovered normally and ready to resume development."; }],
  ["complete-block", "COMPLETE_BLOCK", "The final reduced week was athlete-reported completed with ordinary reported effort, and the block has reached its planned end. Select the next strategy through reassessment; measured recovery and target execution remain unknown.", context => {
    prescribeRecoveryWeek(context);
    context.block.startDate = "2026-08-17"; context.block.plannedEndDate = "2026-09-14"; context.block.weekIndex = 3; context.remainingWeekPattern = [];
  }],
  ["replan-new-race", "REPLAN_BLOCK", "A newly added high-importance near-term short race materially changes the original general-fitness long-endurance assumptions. Reassess the block strategy, not merely one workout; prior execution remains unverified.", context => {
    context.planningObjective.mode = "RACE_TARGETED";
    context.evidence.races = [{ id: 2, goal: { name: "New 800 m track race", eventType: "RUN", sports: ["RUN"], date: "2026-09-20", importance: 95, distanceMeters: 800, expectedDurationSeconds: 120, performanceGoal: "This newly entered short race is my highest-priority event.", demandProfile: null } }];
    context.evidence.notes.push("The block was prescribed for general fitness with no race entered. The athlete added this high-importance event on September 13, after the block was prescribed; its date falls in the upcoming week.");
  }],
  ["new-restriction", "REPLAN_BLOCK", "A new ongoing no-running restriction changes the assumptions of the run-focused block.", context => { context.evidence.nextRestrictions = [{ id: "no-run", sport: "RUN", kind: "NO_TRAINING", maxSessionMinutes: null, startDate: "2026-09-14", endDate: null, description: "User added an ongoing no-running restriction." }]; }],
  ["travel-disruption", "HOLD", "Travel reduced training opportunities; hold the useful stimulus without assuming fitness loss.", context => { context.evidence.activities = context.evidence.activities.slice(0, 3); context.evidence.workouts[3].feedback = { rpe: null, comment: "Travel prevented this session; no unusual fatigue reported." }; context.evidence.workouts[3].completion = "PLANNED"; }],
  ["sparse-feedback", "HOLD", "Execution evidence is uncertain in this scenario; a hold is reasonable without inferring poor recovery.", context => { context.evidence.workouts.forEach(workout => { workout.completion = "UNREPORTED"; workout.feedback = null; }); context.evidence.activities = []; context.evidence.notes.push("Ingestion may be incomplete; absence of recorded activity is not proof of inactivity."); }],
  ["primary-long-session", "PROGRESS", "Successful primary run work supports a small LONG_SESSION change, potentially redistributing existing weekly minutes.", () => {}],
  ["secondary-time-at-intensity", "PROGRESS", "Successful primary and secondary work supports selective progression, including useful bike time at intensity.", context => { context.evidence.workouts[1].feedback = { rpe: 6, comment: "Bike intervals completed as planned with normal recovery." }; }],
  ["maintenance-only", "HOLD", "Successful swim maintenance alone does not establish readiness to progress the primary running focus.", context => { context.evidence.workouts.filter(workout => workout.sport !== "SWIM").forEach(workout => { workout.completion = "UNREPORTED"; workout.feedback = null; }); context.evidence.activities = context.evidence.activities.filter(activity => activity.sport === "SWIM"); }],
  ["general-fitness-review", "PROGRESS", "General fitness uses the same response-based review loop without inventing a race.", () => {}],
  ["race-targeted-review", "PROGRESS", "Race-targeted strategy uses the same review contract and appropriate supplied response.", context => { context.planningObjective.mode = "RACE_TARGETED"; context.evidence.races = planningScenarios().find(value => value.id === "normal-build").input.context.races; context.block.raceIds = [1]; }],
  ["availability-partial-adherence", "HOLD", "Partial training reflects explicit schedule constraints; preserve stimulus without a fatigue diagnosis.", context => { context.evidence.activities.pop(); context.evidence.workouts.at(-1).completion = "PLANNED"; context.evidence.workouts.at(-1).feedback = { rpe: null, comment: "Pool was unavailable; otherwise I felt fine." }; context.evidence.nextAvailability[0].settings.poolAccess = false; }],
  ["protected-history", "PROGRESS", "Review recommends future progression while retaining completed and locked workout history.", context => { context.evidence.workouts.forEach(workout => { workout.locked = true; }); }],
];

export function blockReviewScenarios() {
  const weekly = planningScenarios().find(scenario => scenario.id === "general-fitness-active-block").input.context;
  return scenarios.map(([id, decision, rationale, configure]) => {
    const workouts = ["RUN", "BIKE", "SWIM", "RUN", "BIKE", "SWIM"].map((sport, index) => ({ id: `review-workout-${index}`,
      date: addCalendarDays("2026-09-07", index), sport, title: index === 0 ? "Long easy run" : `${sport} ${index === 1 ? "sustained intervals" : "endurance"}`,
      durationMinutes: { RUN: 60, BIKE: 120, SWIM: 30 }[sport], effort: index === 1 ? "HARD" : "EASY", optional: false,
      completion: "COMPLETED", locked: false, feedback: { rpe: index === 1 ? 7 : 3, comment: "Marked completed; effort felt consistent with the planned session." }, achievedTargets: null,
    }));
    const context = { version: 1, athleteId: 1, sourceFingerprint: "0".repeat(64), block: structuredClone(weekly.developmentBlock),
      planningObjective: { mode: "GENERAL_FITNESS" }, goals: weekly.goals, effectiveWeekStart: "2026-09-14", remainingWeekPattern: ["DEVELOPMENT", "RECOVERY"],
      evidence: { version: 2, generatedAt: "2026-09-14T00:00:00.000Z", timeZone: "UTC", weekStart: "2026-09-07", weekEnd: "2026-09-14", weekComplete: true,
        plan: { id: 1, updatedAt: "2026-09-06T12:00:00.000Z", blockId: 101, blockRevision: 1 }, workouts,
        activityLinkingAvailable: false, activities: workouts.map((workout, index) => ({ id: index + 1, workoutId: null, date: workout.date, sport: workout.sport, durationMinutes: workout.durationMinutes, distanceMeters: null })),
        activitiesTruncated: false, sports: [], restrictions: [], nextRestrictions: [], adjustments: [], nextAdjustments: [],
        nextAvailability: weekly.availability.days.map((day, index) => ({ date: addCalendarDays("2026-09-14", index), settings: structuredClone(day.settings), note: null })),
        races: [], recentHistory: weekly.trainingHistory.weeks.slice(0, 3), notes: ["Synthetic evidence. Completion is athlete-reported. Only explicit activity links establish recorded workout duration; target execution is unavailable."],
      },
    };
    configure(context);
    // These boundaries isolate reported response; no synthetic record implies verification.
    if (blockReviewBoundaryScenarioIds.includes(id)) context.evidence.activities = [];
    context.evidence.sports = summarizeBlockReviewSports(context.evidence.workouts, context.evidence.activities, true);
    const focusGuidance = context.block.focuses.map(focus => ({ focusId: developmentFocusId(focus),
      action: focus.role === "MAINTENANCE" ? "MAINTAIN" : decision === "PROGRESS" &&
        (focus.role === "PRIMARY" || ["both-focuses-progress", "secondary-time-at-intensity"].includes(id)) ? "PROGRESS" : "HOLD",
      rationale: focus.role === "MAINTENANCE" ? "Preserve maintenance exposure without adding a development priority."
        : focus.role === "SECONDARY" && decision === "PROGRESS" && !["both-focuses-progress", "secondary-time-at-intensity"].includes(id)
          ? "Preserve the secondary stimulus while prioritizing the primary focus and accounting for supplied feedback." : rationale,
    }));
    return { id, context: BlockReviewContextSchema.parse(context), proposal: { decision, rationale, focusGuidance } };
  });
}
