import { config } from "dotenv";
import { Worker, UnrecoverableError } from "bullmq";
import { JOBS, QUEUES, PingJobSchema, type PingJob } from "@pkg/shared";
import { bullConnectionFromEnv } from "./redis.js";

config({ path: new URL("../../../.env", import.meta.url), quiet: true });

const worker = new Worker<PingJob>(
  QUEUES.jobs,
  async (job) => {
    if (job.name !== JOBS.ping) {
      throw new UnrecoverableError(`Unsupported job: ${job.name}`);
    }
    const parsed = PingJobSchema.safeParse(job.data);
    if (!parsed.success) {
      throw new UnrecoverableError(`Invalid PingJob: ${parsed.error.message}`);
    }
    console.log(`Processed PingJob ${job.id} for user ${parsed.data.userId}`);
    return { processed: true, userId: parsed.data.userId };
  },
  { connection: bullConnectionFromEnv() },
);

worker.on("ready", () => console.log(`Worker ready on queue ${QUEUES.jobs}`));
worker.on("failed", (job, error) => console.error(`Job ${job?.id} failed: ${error.message}`));
worker.on("error", (error) => console.error("Worker error:", error.message));

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await worker.close();
}
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });