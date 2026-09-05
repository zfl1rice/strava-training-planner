import { config } from "dotenv";
import { Worker, UnrecoverableError } from "bullmq";
import { JOBS, QUEUES, SyncAthleteJobSchema } from "@pkg/shared";
import { bullConnectionFromEnv } from "./redis.js";

config({ path: new URL("../../../.env", import.meta.url), quiet: true });
// Load the database only after the root environment has been read.
const { processJob, stravaBackoff } = await import("./processor.js");
const { prisma, recordSyncFailure } = await import("@pkg/db");

const worker = new Worker(
  QUEUES.jobs,
  processJob,
  { connection: bullConnectionFromEnv(), prefix: process.env.BULLMQ_PREFIX ?? "bull", settings: { backoffStrategy: stravaBackoff } },
);

worker.on("ready", () => console.log(`Worker ready on queue ${QUEUES.jobs}`));
worker.on("failed", (job, error) => {
  console.error(`Job ${job?.id} failed: ${error.message}`);
  // Include terminal failures raised by BullMQ itself, such as repeated stalls.
  if (job?.name !== JOBS.syncAthlete) return;
  const parsed = SyncAthleteJobSchema.safeParse(job.data);
  const terminal = error instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1) || error.message.includes("stalled");
  if (parsed.success && terminal) {
    void recordSyncFailure(parsed.data.jobRunId, "Sync stopped. Please try again or reconnect Strava.", false)
      .catch(() => console.error("Could not record terminal sync failure"));
  }
});
worker.on("error", (error) => console.error("Worker error:", error.message));

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await worker.close();
  await prisma.$disconnect();
}
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
