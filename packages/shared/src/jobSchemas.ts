import { z } from "zod";

export const PingJobSchema = z.object({
  userId: z.number().int(),
});

export type PingJob = z.infer<typeof PingJobSchema>;

export const SyncAthleteJobSchema = z.object({
  jobRunId: z.number().int().positive(),
}).strict();

export type SyncAthleteJob = z.infer<typeof SyncAthleteJobSchema>;

export const GeneratePlanJobSchema = z.object({ jobRunId: z.number().int().positive() }).strict();
export type GeneratePlanJob = z.infer<typeof GeneratePlanJobSchema>;
