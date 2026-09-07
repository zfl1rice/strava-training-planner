import { z } from "zod";
import { ActiveDevelopmentBlockSchema, BlockDecisionSchema, BlockMondaySchema, BlockReviewRequestSchema, BlockWeekRoleSchema, FocusReferenceGuidanceEntrySchema, focusGuidanceIssues, resolveFocusGuidance, allowedFocusGuidanceMessage, weeksBetween } from "./development-block.js";
import { BlockReviewEvidenceSchema } from "./block-review-evidence.js";
import { PlanningObjectiveSchema } from "./planning-context.js";
import { WeeklyGoalsSchema } from "./planner.js";
import { addCalendarDays } from "./planning-dates.js";
import { ProposalAttemptsExhaustedError, ProposalValidationError, type ProposalAttempt, type ProposalIssue } from "./plan-generation.js";

export const BlockReviewContextSchema = z.object({
  version: z.literal(1), athleteId: z.number().int().positive(),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  block: ActiveDevelopmentBlockSchema, planningObjective: PlanningObjectiveSchema, goals: WeeklyGoalsSchema,
  effectiveWeekStart: BlockMondaySchema, remainingWeekPattern: BlockWeekRoleSchema.array().max(52),
  evidence: BlockReviewEvidenceSchema,
}).strict().superRefine((value, context) => {
  if (value.block.weekIndex === null || value.block.weekRole === null ||
    value.block.weekIndex !== weeksBetween(value.block.startDate, value.evidence.weekStart) ||
    value.evidence.weekEnd !== addCalendarDays(value.evidence.weekStart, 7) ||
    value.effectiveWeekStart !== value.evidence.weekEnd) context.addIssue({ code: "custom", message: "Review must cover a block week and affect the following week" });
});
export type BlockReviewContext = z.infer<typeof BlockReviewContextSchema>;
export const BlockReviewProposalSchema = z.object({
  decision: BlockDecisionSchema, rationale: z.string().trim().min(1).max(2000),
  focusGuidance: FocusReferenceGuidanceEntrySchema.array().min(1).max(12),
}).strict();
export type BlockReviewProposal = z.infer<typeof BlockReviewProposalSchema>;
export interface BlockReviewer {
  source: "SIMULATED" | "OPENAI";
  review(context: BlockReviewContext, attempt: ProposalAttempt): Promise<unknown>;
}

// Supplied recommendations enable repeatable local reviews without inventing a
// universal RPE/readiness rule or treating missing data as an automatic HOLD.
export function simulatedBlockReviewer(proposal: BlockReviewProposal): BlockReviewer {
  const parsed = BlockReviewProposalSchema.parse(proposal);
  return { source: "SIMULATED", async review() { return structuredClone(parsed); } };
}

export function validateBlockReviewProposal(context: BlockReviewContext, value: unknown): BlockReviewProposal {
  const parsed = BlockReviewProposalSchema.safeParse(value);
  if (!parsed.success) throw new ProposalValidationError(parsed.error.issues.map(issue => ({ code: "SCHEMA", path: issue.path,
    message: `${issue.message}. ${allowedFocusGuidanceMessage(context.block.focuses)}` })));
  const issues: ProposalIssue[] = [];
  issues.push(...focusGuidanceIssues(context.block.focuses, parsed.data.decision, parsed.data.focusGuidance)
    .map(message => ({ code: "FOCUS_GUIDANCE", path: ["focusGuidance"], message })));
  if (parsed.data.decision === "CONTINUE_RECOVERY" && context.block.weekRole !== "RECOVERY") issues.push({ code: "REVIEW_ROLE", path: ["decision"], message: "CONTINUE_RECOVERY requires a reviewed RECOVERY week." });
  if (parsed.data.decision === "RECOVER_EARLY" && context.remainingWeekPattern[0] !== "DEVELOPMENT") issues.push({ code: "REVIEW_ROLE", path: ["decision"], message: "RECOVER_EARLY replaces the next planned DEVELOPMENT week." });
  if (issues.length) throw new ProposalValidationError(issues);
  return parsed.data;
}

export function blockReviewRequest(context: BlockReviewContext, raw: BlockReviewProposal) {
  const proposal = validateBlockReviewProposal(context, raw);
  let pattern = [...context.remainingWeekPattern];
  if (proposal.decision === "RECOVER_EARLY" || proposal.decision === "CONTINUE_RECOVERY") pattern = ["RECOVERY", ...pattern.slice(1)];
  if (proposal.decision === "PROGRESS" && (!pattern.length || (context.block.weekRole === "RECOVERY" && pattern[0] === "RECOVERY"))) pattern = ["DEVELOPMENT", ...pattern.slice(1)];
  if (proposal.decision === "HOLD" && !pattern.length) pattern = [context.block.weekRole === "RECOVERY" ? "RECOVERY" : "DEVELOPMENT"];
  return BlockReviewRequestSchema.parse({ reviewedWeekStart: context.evidence.weekStart,
    effectiveWeekStart: context.effectiveWeekStart, ...proposal,
    focusGuidance: resolveFocusGuidance(context.block.focuses, proposal.focusGuidance),
    ...(["COMPLETE_BLOCK", "REPLAN_BLOCK"].includes(proposal.decision) ? {} : { remainingWeekPattern: pattern }),
  });
}

export async function generateBlockReview(raw: BlockReviewContext, reviewer: BlockReviewer,
  execution: Pick<ProposalAttempt, "signal" | "reportCall"> = {}) {
  const context = BlockReviewContextSchema.parse(raw);
  let previousErrors: ProposalIssue[] = [];
  let previousProposal: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    execution.signal?.throwIfAborted();
    const value = await reviewer.review(structuredClone(context), { ...execution, attempt,
      previousErrors: structuredClone(previousErrors), previousProposal: structuredClone(previousProposal) });
    execution.signal?.throwIfAborted();
    try { return validateBlockReviewProposal(context, value); }
    catch (error) {
      if (!(error instanceof ProposalValidationError)) throw error;
      previousErrors = error.issues;
      previousProposal = value;
    }
  }
  throw new ProposalAttemptsExhaustedError(previousErrors, 3);
}
