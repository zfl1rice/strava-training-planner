import { z } from "zod";

export const ProviderCallMetadataSchema = z.object({
  provider: z.string(), model: z.string(), responseId: z.string().nullable(),
  proposalAttempt: z.number().int().positive(), infrastructureAttempt: z.number().int().positive().optional(),
  latencyMs: z.number().nonnegative(),
  inputTokens: z.number().int().nonnegative().nullable(), cachedInputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(), totalTokens: z.number().int().nonnegative().nullable(),
  category: z.enum(["RESPONSE", "REFUSAL", "INCOMPLETE", "MALFORMED", "TIMEOUT", "CANCELLED", "TRANSIENT", "CONFIGURATION", "PROVIDER_ERROR"]),
}).strict();
export type ProviderCallMetadata = z.infer<typeof ProviderCallMetadataSchema>;
export const ProviderExecutionSchema = z.object({
  calls: z.array(ProviderCallMetadataSchema).max(9).default([]),
  proposals: z.array(z.object({ attempt: z.number().int().min(1).max(3), json: z.string().max(500000) }).strict()).max(3).default([]),
}).strict();
export const PlanProvenanceSchema = z.object({ provider: z.string(), model: z.string(), responseId: z.string().nullable(), jobRunId: z.number().int().positive() }).strict();

// Safe messages only: raw SDK errors may contain response bodies or request details.
export class PlanProviderError extends Error {
  constructor(public readonly category: ProviderCallMetadata["category"], message: string,
    public readonly retryable = false, public readonly retryAfterMs = 0) {
    super(message); this.name = "PlanProviderError";
  }
}
