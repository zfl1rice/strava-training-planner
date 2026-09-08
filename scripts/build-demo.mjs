import { writeFile } from "node:fs/promises";
import { easyWorkout, finalizePlanProposal, DevelopmentBlockSchema, blockReviewRequest } from "@pkg/shared";
import { planningScenarios } from "../tests/fixtures/planning-scenarios.mjs";
import { blockReviewScenarios } from "../tests/fixtures/block-review-scenarios.mjs";

// Writes only a checked-in synthetic fixture. No database, sessions, keys or API calls.
const input = planningScenarios().find(value => value.id === "general-fitness-active-block").input;
const workouts = [
  ["2026-09-07", "SWIM", 30], ["2026-09-08", "BIKE", 120], ["2026-09-09", "RUN", 50],
  ["2026-09-11", "SWIM", 30], ["2026-09-12", "BIKE", 120], ["2026-09-13", "RUN", 70],
].map(([date, sport, minutes]) => easyWorkout(`${date}-${sport}`, date, sport, minutes));
const bike = workouts[1];
bike.title = "Bike threshold intervals 3 × 8 min";
bike.explanation = "Synthetic example: maintain a focused cycling stimulus while run endurance is the primary block emphasis.";
const segment = (label, seconds, lower, upper, instructions) => ({ label, seconds, instructions, target: { metric: "FTP_PERCENT", lower, upper } });
bike.blocks = [
  { repeat: 1, segments: [segment("Warm-up", 900, 45, 65, "Build gradually into a comfortable cadence.")] },
  { repeat: 3, segments: [segment("Controlled threshold", 480, 95, 100, "Keep the effort smooth and repeatable."), segment("Easy recovery", 240, 45, 55, "Spin gently between efforts.")] },
  { repeat: 1, segments: [segment("Aerobic endurance", 3540, 60, 70, "Settle into steady aerobic riding."), segment("Cool-down", 600, 40, 50, "Ease down gradually.")] },
];
const plan = finalizePlanProposal(input, { version: 1, explanation: "Hand-authored synthetic demonstration. Desired goals: run 120, bike 240, swim 60 minutes. Not a live AI result or individualized prescription.", workouts });
const scenario = blockReviewScenarios().find(value => value.id === "successful-run-block");
const block = input.context.developmentBlock;
const request = blockReviewRequest(scenario.context, { decision: "PROGRESS", rationale: "Synthetic example: athlete-reported run completion supports a small primary progression; hold cycling stimulus and maintain swimming. Exact target execution remains unverified.",
  focusGuidance: block.focuses.map(focus => ({ focusId: `${focus.sport}:${focus.capability}`, action: focus.role === "PRIMARY" ? "PROGRESS" : focus.role === "SECONDARY" ? "HOLD" : "MAINTAIN", rationale: "Illustrative guidance, not a measured fitness conclusion." })) });
const fullBlock = DevelopmentBlockSchema.parse({ id: 101, userId: 1, revision: 2, status: "ACTIVE", createdAt: "2026-08-30T12:00:00.000Z", updatedAt: "2026-09-14T12:00:00.000Z",
  proposal: { version: 1, startDate: block.startDate, phase: block.phase, focuses: block.focuses, weekPattern: ["DEVELOPMENT", "DEVELOPMENT", "DEVELOPMENT", "RECOVERY"], raceIds: [], rationale: block.rationale },
  reviews: [{ id: 1, revision: 2, createdAt: "2026-09-14T12:00:00.000Z", request, response: {
    capturedAt: "2026-09-14T12:00:00.000Z", restrictions: [], availability: scenario.context.evidence.nextAvailability, sports: scenario.context.evidence.sports,
    feedback: [], feedbackTruncated: false, performanceEvidenceIds: [], notes: ["Synthetic demonstration only."],
  }, source: { provider: "SIMULATED", version: "block-review-v3", model: null, responseId: null } }],
});
const data = {
  calendar: { month: "2026-09", timeZone: "UTC", plans: [{ id: 1, updatedAt: "2026-09-06T12:00:00.000Z", content: plan, workoutStates: [] }],
    activities: workouts.map((workout, index) => ({ id: index + 1, name: `Sample ${workout.sport.toLowerCase()} activity`, type: workout.sport,
      startedAt: `${workout.date.replace(/\d{2}$/, day => String(Number(day) - 6).padStart(2, "0"))}T12:00:00Z`,
      durationSeconds: workout.durationMinutes * 60, distanceMeters: workout.sport === "SWIM" ? 1200 : workout.sport === "BIKE" ? 50000 : 9000, stravaActivityId: null })) },
  block: { block: fullBlock, review: null, reviewWeeks: [], currentMonday: "2026-09-14" },
};
await writeFile(new URL("../apps/web/src/app/demo/sample.json", import.meta.url), JSON.stringify(data, null, 2) + "\n");
console.log("Wrote synthetic demo fixture; no application records were changed.");
