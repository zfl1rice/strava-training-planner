import { z } from "zod";

export const PingJobSchema = z.object({
  userId: z.number().int(),
});

export type PingJob = z.infer<typeof PingJobSchema>;
