import type OpenAI from "openai";
import { createStructuredResponder } from "./openai-structured-response.js";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import {
  LocalDateSchema, PlanProposalSchema, StructuredWorkoutSchema, WorkoutBlockSchema, WorkoutSegmentSchema, WorkoutTargetSchema,
  type PlanProvider,
} from "@pkg/shared";
import { buildOpenAIPlanningInput, PLANNER_INSTRUCTIONS } from "./planner-prompt.js";
import type { OpenAIPlannerConfig } from "./planner-config.js";

// JSON Schema cannot encode trimming or cross-field refinements. Derive the wire
// shape from the domain contracts; the existing finalizer still applies all rules.
const segment = WorkoutSegmentSchema.omit({ resolved: true }).extend({
  label: z.string().min(1).max(100), instructions: z.string().min(1).max(2000), target: WorkoutTargetSchema.innerType(),
});
const workout = StructuredWorkoutSchema.innerType().extend({
  date: LocalDateSchema.innerType(), title: z.string().min(1).max(200),
  blocks: WorkoutBlockSchema.extend({ segments: segment.array().min(1).max(20) }).array().min(1).max(50),
});
export const OpenAIPlanProposalSchema = PlanProposalSchema.extend({
  explanation: z.string().min(1).max(8000), workouts: workout.array().max(168),
});
export const OPENAI_PLAN_FORMAT = zodTextFormat(OpenAIPlanProposalSchema, "weekly_plan_proposal");

export function createOpenAIPlanProvider(config: OpenAIPlannerConfig, client?: OpenAI): PlanProvider {
  const respond = createStructuredResponder(config, client);
  return (input, attempt) => respond({ instructions: PLANNER_INSTRUCTIONS,
    input: { planning: buildOpenAIPlanningInput(input),
      correction: attempt.previousErrors.length ? { attempt: attempt.attempt, errors: attempt.previousErrors, previousProposal: attempt.previousProposal ?? null } : null },
    format: OPENAI_PLAN_FORMAT, schema: OpenAIPlanProposalSchema,
  }, attempt);
}
