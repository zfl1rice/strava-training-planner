import { PlanningContextSchema, makeBlockPlanningContext } from "@pkg/shared";
import { planningScenarios } from "./planning-scenarios.mjs";

const focus = (sport, capability, role = "PRIMARY", progressionStrategy = "LONG_SESSION") => ({
  sport, capability, role, progressionStrategy, rationale: "Explicit synthetic strategic assessment; not inferred from scores.",
});
const run = () => focus("RUN", "LONG_ENDURANCE");
const maintenance = () => focus("BIKE", "THRESHOLD", "MAINTENANCE", "MAINTAIN");
const previous = (status = "COMPLETED") => ({ id: 90, status, proposal: {
  version: 1, startDate: "2026-08-03", phase: "BUILD", focuses: [run(), maintenance()],
  weekPattern: ["DEVELOPMENT", "DEVELOPMENT", "DEVELOPMENT", "RECOVERY"], raceIds: [], rationale: "Previous supplied strategy.",
} });

// Decisions and phases are supplied fixture inputs, not a claim that the local
// provider can diagnose readiness or calculate season boundaries from dates.
const definitions = [
  ["general-fitness-stable", "Stable training without races", () => {}],
  ["supported-run-durability", "Supplied assessment supports run development", s => {
    s.weekly.performanceProfile = planningScenarios().find(s => s.id === "asymmetric-evidence").input.context.performanceProfile;
    s.direction.focuses = [run(), maintenance()];
    s.direction.rationale = "Supplied assessor identifies run durability as a development need; retain cited synthetic evidence, do not derive a threshold from scores.";
  }],
  ["progress", "Supplied response supports targeted progression", s => { s.decision = "PROGRESS"; }],
  ["hold", "Supplied response calls for holding the current stimulus", s => { s.decision = "HOLD"; s.reviewRationale = "Athlete reports unusually high effort; hold the useful stimulus without changing baselines."; }],
  ["early-recovery", "Explicit accumulating-fatigue report changes future week roles", s => { s.decision = "RECOVER_EARLY"; s.remainingWeekPattern = ["RECOVERY", "RETURN"]; }],
  ["return", "Return after an explicitly reported illness/travel interruption", s => { s.direction.phase = "RECOVERY_TRANSITION"; s.direction.weekPattern = ["RETURN", "DEVELOPMENT"]; s.direction.rationale = "Athlete reports a training interruption; use history as context, not proof of immediate tolerance."; }],
  ["far-race", "Far-away 70.3 with supplied general-preparation phase", s => { s.raceDate = "2027-05-01"; s.direction.phase = "GENERAL_PREPARATION"; }],
  ["build-race", "Approaching 70.3 with supplied build phase", s => { s.raceDate = "2026-11-01"; s.direction.phase = "BUILD"; }],
  ["specific-race", "Closer 70.3 with supplied race-specific phase", s => { s.raceDate = "2026-10-01"; s.direction.phase = "RACE_SPECIFIC"; }],
  ["taper-race", "Supplied event-specific taper context", s => { s.raceDate = "2026-09-20"; s.direction.phase = "TAPER"; s.direction.weekPattern = ["TAPER", "RACE"]; }],
  ["post-race", "Past event retained for recovery/transition, not invented as a future race", s => { s.raceDate = "2026-09-05"; s.direction.phase = "RECOVERY_TRANSITION"; s.direction.weekPattern = ["RECOVERY", "RETURN"]; }],
  ["competing-races", "70.3 plus important short cycling event", s => {
    s.weekly.races = planningScenarios().find(s => s.id === "equal-races").input.context.races;
    s.direction.raceIds = s.weekly.races.map(race => race.id);
    s.direction.focuses = [focus("BIKE", "TWO_TO_FIVE_MINUTE_POWER", "PRIMARY", "REPETITIONS"), focus("RUN", "LONG_ENDURANCE", "SECONDARY")];
  }],
  ["new-race-replan", "Explicit replan after a new race changes the strategy", s => { s.raceDate = "2026-10-01"; s.recentBlocks = [previous("ABORTED")]; s.direction.rationale = "REPLAN_BLOCK supplied after a new race materially changed goals."; }],
  ["restriction-replan", "Explicit restriction-driven replacement preserves prior block history", s => {
    s.recentBlocks = [previous("ABORTED")];
    s.weekly.restrictions = [{ id: "run-pause", sport: "RUN", kind: "NO_TRAINING", maxSessionMinutes: null,
      startDate: "2026-09-07", endDate: null, description: "Explicit athlete restriction: no running until updated." }];
    s.weekly.availability.days.forEach(day => { day.settings.allowedSports = ["BIKE", "SWIM"]; });
    s.direction.focuses = [focus("BIKE", "THRESHOLD", "PRIMARY", "TIME_AT_INTENSITY")];
    s.direction.rationale = "REPLAN_BLOCK supplied after a new no-running restriction; no diagnosis inferred.";
  }],
  ["missing-evidence", "Unknown capabilities remain unknown", s => { s.weekly.performanceProfile = { cycling: [], running: [], swimming: [], evidence: [], historyRecordCount: 0, evidenceTruncated: false }; }],
  ["maintain-strength", "Supplied maintenance strength alongside another development focus", s => { s.direction.focuses = [run(), maintenance()]; }],
  ["recovery-same-goals", "Recovery role changes, saved desired hours stay the same", s => { s.decision = "RECOVER_EARLY"; s.remainingWeekPattern = ["RECOVERY"]; }],
  ["completion-next-focus", "Completion permits another broad general-fitness emphasis", s => { s.recentBlocks = [previous()]; }],
];

export function blockScenarios() {
  const normal = planningScenarios().find(scenario => scenario.id === "normal-build").input.context;
  return definitions.map(([id, description, configure]) => {
    const weekly = structuredClone(normal);
    weekly.races = [];
    const scenario = { id, description, weekly, direction: { startDate: weekly.targetWeek.startDate,
      phase: "BUILD", raceIds: [], rationale: "Supplied local development strategy; sufficient useful stimulus, not always less." }, recentBlocks: [] };
    configure(scenario);
    if (scenario.raceDate) {
      scenario.weekly.races = [{ id: 1, goal: { ...normal.races[0].goal, date: scenario.raceDate } }];
      scenario.direction.raceIds = [1];
      scenario.direction.focuses = [run(), maintenance()];
    }
    if (scenario.decision) scenario.direction.startDate = "2026-08-31";
    scenario.weekly = PlanningContextSchema.parse(scenario.weekly);
    scenario.context = makeBlockPlanningContext(scenario.weekly, scenario.direction, scenario.recentBlocks);
    return scenario;
  });
}
