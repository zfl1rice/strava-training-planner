import { config } from "dotenv";
import { Worker } from "bullmq";
import { bullConnectionFromUrl, QUEUES } from "@pkg/shared";

config({ path: new URL("../../../.env", import.meta.url), quiet: true });
// Load the database only after the root environment has been read.
const { processJob, stravaBackoff } = await import("./processor.js");
const { prisma } = await import("@pkg/db");
const { startSyncRecovery } = await import("./recovery.js");

const worker = new Worker(
  QUEUES.jobs,
  processJob,
  {
    connection: {
      ...bullConnectionFromUrl(process.env.REDIS_URL),
      // BullMQ's background consumer must keep waiting through Redis outages.
      maxRetriesPerRequest: null,
    },
    prefix: process.env.BULLMQ_PREFIX ?? "bull",
    settings: { backoffStrategy: stravaBackoff },
  },
);
const stopSyncRecovery = startSyncRecovery();

worker.on("ready", () => console.log(`Worker ready on queue ${QUEUES.jobs}`));
worker.on("failed", (job, error) => {
  console.error(`Job ${job?.id} failed: ${error.message}`);
  // Processor persists owned failures; recovery reconciles terminal BullMQ states.
  // An event from an old execution must not overwrite a newer DB attempt.
});
worker.on("error", (error) => console.error("Worker error:", error.message));

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await stopSyncRecovery();
  await worker.close();
  await prisma.$disconnect();
}
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
