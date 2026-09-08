import { z } from "zod";
import type { TrainingFocus } from "./training-focus.js";
import { BlockReviewContextSchema } from "./block-review.js";
import { BlockMondaySchema, type DevelopmentBlock } from "./development-block.js";
import { ProviderExecutionSchema } from "./provider-call.js";

export const StoredReviewJobSchema = z.object({ snapshot: BlockReviewContextSchema, execution: ProviderExecutionSchema });
export type StoredReviewJob = z.infer<typeof StoredReviewJobSchema>;
export const ReviewWeekRequestSchema = z.object({ blockId: z.number().int().positive(), revision: z.number().int().positive(), weekStart: BlockMondaySchema }).strict();
export type TrainingBlockState = {
  trainingFocus?: TrainingFocus;
  profileUpdatedAt?: string | null;
  block: DevelopmentBlock | null;
  review: { id: number; status: string; error: string | null } | null;
  reviewWeeks: string[];
  currentMonday: string;
};
