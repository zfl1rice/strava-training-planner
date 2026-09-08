import { z } from "zod";
import { PlanSportSchema } from "./planner.js";

const Weight = z.number().finite().min(0).max(100);
const FocusWeightsSchema = z.object({ RUN: Weight, BIKE: Weight, SWIM: Weight }).strict();
/** Relative preference only: never a minute budget or a sport exclusion. */
export const TrainingFocusSchema = FocusWeightsSchema.refine(
  value => value.RUN + value.BIKE + value.SWIM === 100 && Object.values(value).every(Number.isInteger),
  "Training focus must contain whole percentages totaling 100%",
);
export type TrainingFocus = z.infer<typeof TrainingFocusSchema>;
export const SaveTrainingFocusRequestSchema = z.object({
  action: z.literal("SAVE_FOCUS"), focus: TrainingFocusSchema, expectedUpdatedAt: z.string().datetime().nullable(),
}).strict();
export const DEFAULT_TRAINING_FOCUS: TrainingFocus = { RUN: 34, BIKE: 33, SWIM: 33 };

/** Largest-remainder allocation keeps the displayed and saved total exactly 100. */
export function normalizeTrainingFocus(input: unknown): TrainingFocus {
  const weights = FocusWeightsSchema.parse(input);
  const total = weights.RUN + weights.BIKE + weights.SWIM;
  if (total === 0) throw new Error("Give at least one sport some emphasis.");
  const shares = PlanSportSchema.options.map(sport => ({ sport, exact: weights[sport] * 100 / total }));
  const result = Object.fromEntries(shares.map(({ sport, exact }) => [sport, Math.floor(exact)])) as TrainingFocus;
  const remaining = 100 - Object.values(result).reduce((sum, value) => sum + value, 0);
  shares.sort((a, b) => (b.exact % 1) - (a.exact % 1));
  for (const { sport } of shares.slice(0, remaining)) result[sport]++;
  return TrainingFocusSchema.parse(result);
}
